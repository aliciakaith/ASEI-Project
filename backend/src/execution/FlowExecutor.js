// Flow Execution Engine
// Interprets and executes flows based on their graph structure

import { query } from '../db/postgres.js';
import axios from 'axios';

class FlowExecutor {
  constructor(executionId, flowId, flowVersion, triggerType, triggerData = {}) {
    this.executionId = executionId;
    this.flowId = flowId;
    this.flowVersion = flowVersion;
    this.triggerType = triggerType;
    this.triggerData = triggerData;
    this.nodeOutputs = new Map(); // Store outputs from each node
    this.context = { ...triggerData }; // Execution context passed between nodes
  }

  async log(level, message, metadata = {}, stepId = null) {
    try {
      await query(
        `INSERT INTO execution_logs (execution_id, step_id, level, message, metadata) 
         VALUES ($1, $2, $3, $4, $5)`,
        [this.executionId, stepId, level, message, JSON.stringify(metadata)]
      );
    } catch (error) {
      console.error('Failed to write execution log:', error);
    }
  }

  async execute() {
    const startTime = Date.now();
    
    try {
      await this.log('info', 'Flow execution started', {
        flowId: this.flowId,
        version: this.flowVersion,
        triggerType: this.triggerType
      });

      // Load flow graph
      const flowData = await query(
        `SELECT graph FROM flow_versions WHERE flow_id = $1 AND version = $2`,
        [this.flowId, this.flowVersion]
      );

      if (flowData.rows.length === 0) {
        throw new Error(`Flow version ${this.flowVersion} not found`);
      }

      const graph = flowData.rows[0].graph;
      if (!graph || !graph.nodes || !graph.edges) {
        throw new Error('Invalid flow graph structure');
      }

      await this.log('info', `Loaded flow graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`);

      // Build execution plan (topological sort)
      const executionPlan = this.buildExecutionPlan(graph);
      await this.log('info', `Execution plan built: ${executionPlan.map(n => n.id).join(' → ')}`);

      // Execute nodes in order
      for (const node of executionPlan) {
        await this.executeNode(node, graph);
      }

      // Mark execution as completed
      const executionTime = Date.now() - startTime;
      await query(
        `UPDATE flow_executions 
         SET status = 'completed', completed_at = now(), execution_time_ms = $1 
         WHERE id = $2`,
        [executionTime, this.executionId]
      );

      await this.log('info', `Flow execution completed successfully in ${executionTime}ms`);
      
      return {
        success: true,
        executionId: this.executionId,
        executionTime,
        outputs: Object.fromEntries(this.nodeOutputs)
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;
      await query(
        `UPDATE flow_executions 
         SET status = 'failed', completed_at = now(), error_message = $1, execution_time_ms = $2 
         WHERE id = $3`,
        [error.message, executionTime, this.executionId]
      );

      await this.log('error', `Flow execution failed: ${error.message}`, {
        error: error.stack
      });

      return {
        success: false,
        executionId: this.executionId,
        error: error.message,
        executionTime
      };
    }
  }

  buildExecutionPlan(graph) {
    const { nodes, edges } = graph;
    const adjacency = new Map();
    const inDegree = new Map();

    // Initialize
    nodes.forEach(node => {
      adjacency.set(node.id, []);
      inDegree.set(node.id, 0);
    });

    // Build adjacency list
    edges.forEach(edge => {
      adjacency.get(edge.from).push(edge.to);
      inDegree.set(edge.to, inDegree.get(edge.to) + 1);
    });

    // Find nodes with no dependencies (triggers)
    const queue = nodes.filter(node => inDegree.get(node.id) === 0);
    const executionPlan = [];

    // Topological sort
    while (queue.length > 0) {
      const node = queue.shift();
      executionPlan.push(node);

      const neighbors = adjacency.get(node.id) || [];
      neighbors.forEach(neighborId => {
        inDegree.set(neighborId, inDegree.get(neighborId) - 1);
        if (inDegree.get(neighborId) === 0) {
          const neighborNode = nodes.find(n => n.id === neighborId);
          if (neighborNode) queue.push(neighborNode);
        }
      });
    }

    // Check for cycles
    if (executionPlan.length !== nodes.length) {
      throw new Error('Flow contains cycles or disconnected nodes');
    }

    return executionPlan;
  }

  async executeNode(node, graph) {
    const stepId = (await query(
      `INSERT INTO execution_steps (execution_id, node_id, node_type, node_kind, status) 
       VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
      [this.executionId, node.id, node.type, node.kind]
    )).rows[0].id;

    const startTime = Date.now();

    try {
      await this.log('info', `Executing node: ${node.label || node.id}`, {
        nodeType: node.type,
        nodeKind: node.kind
      }, stepId);

      // Get input data from predecessor nodes
      const inputEdges = graph.edges.filter(e => e.to === node.id);
      const inputData = {};
      
      inputEdges.forEach(edge => {
        const predecessorOutput = this.nodeOutputs.get(edge.from);
        if (predecessorOutput) {
          inputData[edge.from] = predecessorOutput;
        }
      });

      // Execute based on node type and kind
      let output;
      
      // Handle special node types
      if (node.type === 'start') {
        // Start nodes just pass through the trigger data
        output = await this.executeTrigger(node, stepId);
      } else if (node.type === 'end') {
        // End nodes collect all inputs and mark completion
        output = { completed: true, inputs: inputData, timestamp: new Date().toISOString() };
        await this.log('info', 'Flow reached end node', { output }, stepId);
      } else if (node.type === 'trigger') {
        output = await this.executeTrigger(node, stepId);
      } else if (node.type === 'condition') {
        output = await this.executeCondition(node, inputData, stepId);
      } else if (node.type === 'transform') {
        output = await this.executeTransform(node, inputData, stepId);
      } else if (node.kind === 'api' || node.type.includes('.') || node.type === 'action') {
        // API nodes (MTN, Flutterwave, HTTP, etc.)
        output = await this.executeAction(node, inputData, stepId);
      } else {
        // Default to action for unknown types
        await this.log('warn', `Unknown node type '${node.type}', treating as action`, {}, stepId);
        output = await this.executeAction(node, inputData, stepId);
      }

      // Store output
      this.nodeOutputs.set(node.id, output);
      this.context[node.id] = output;

      const executionTime = Date.now() - startTime;
      await query(
        `UPDATE execution_steps 
         SET status = 'completed', completed_at = now(), input_data = $1, output_data = $2, execution_time_ms = $3 
         WHERE id = $4`,
        [JSON.stringify(inputData), JSON.stringify(output), executionTime, stepId]
      );

      await this.log('info', `Node completed in ${executionTime}ms`, { output }, stepId);

    } catch (error) {
      const executionTime = Date.now() - startTime;
      await query(
        `UPDATE execution_steps 
         SET status = 'failed', completed_at = now(), error_message = $1, execution_time_ms = $2 
         WHERE id = $3`,
        [error.message, executionTime, stepId]
      );

      await this.log('error', `Node failed: ${error.message}`, {
        error: error.stack
      }, stepId);

      throw error;
    }
  }

  async executeTrigger(node, stepId) {
    // Triggers provide initial data from the trigger source
    await this.log('info', 'Trigger node activated', { triggerData: this.triggerData }, stepId);
    return this.triggerData;
  }

  async executeAction(node, inputData, stepId) {
    const { kind } = node;
    
    switch (kind) {
      case 'http':
        return await this.executeHttpAction(node, inputData, stepId);
      
      case 'salesforce':
        return await this.executeSalesforceAction(node, inputData, stepId);
      
      case 'database':
        return await this.executeDatabaseAction(node, inputData, stepId);
      
      case 'email':
        return await this.executeEmailAction(node, inputData, stepId);
      
      default:
        await this.log('warn', `Action kind '${kind}' not yet implemented, returning mock data`, {}, stepId);
        return { success: true, message: `Mock execution of ${kind} action` };
    }
  }

  async executeHttpAction(node, inputData, stepId) {
    // Execute HTTP request
    const config = node.config || {};
    const url = config.url || 'https://api.example.com/endpoint';
    const method = config.method || 'GET';
    const headers = config.headers || {};
    const body = config.body || inputData;

    await this.log('info', `Making ${method} request to ${url}`, { headers, body }, stepId);

    try {
      const response = await axios({
        method,
        url,
        headers,
        data: method !== 'GET' ? body : undefined,
        timeout: 30000
      });

      return {
        status: response.status,
        headers: response.headers,
        data: response.data
      };
    } catch (error) {
      if (error.response) {
        return {
          status: error.response.status,
          error: error.response.data,
          headers: error.response.headers
        };
      }
      throw error;
    }
  }

  async executeSalesforceAction(node, inputData, stepId) {
    await this.log('info', 'Salesforce action (mock)', { inputData }, stepId);
    // Mock Salesforce integration
    return {
      success: true,
      recordId: 'SF_' + Math.random().toString(36).substr(2, 9),
      message: 'Salesforce operation completed (mock)'
    };
  }

  async executeDatabaseAction(node, inputData, stepId) {
    await this.log('info', 'Database action (mock)', { inputData }, stepId);
    // Mock database operation
    return {
      success: true,
      rowsAffected: 1,
      message: 'Database operation completed (mock)'
    };
  }

  async executeEmailAction(node, inputData, stepId) {
    await this.log('info', 'Email action (mock)', { inputData }, stepId);
    // Mock email sending
    return {
      success: true,
      messageId: 'EMAIL_' + Math.random().toString(36).substr(2, 9),
      message: 'Email sent (mock)'
    };
  }

  async executeCondition(node, inputData, stepId) {
    // Evaluate condition and return boolean
    const condition = node.config?.condition || 'true';
    await this.log('info', `Evaluating condition: ${condition}`, { inputData }, stepId);
    
    // Simple condition evaluation (in production, use a proper expression evaluator)
    try {
      // This is a simplified version - in production use a safe expression evaluator
      const result = this.evaluateCondition(condition, inputData);
      return { passed: result, condition };
    } catch (error) {
      await this.log('error', `Condition evaluation failed: ${error.message}`, {}, stepId);
      return { passed: false, error: error.message };
    }
  }

  evaluateCondition(condition, data) {
    // Simple mock condition evaluator
    // In production, use a library like jsonpath or jmespath
    if (condition === 'true' || !condition) return true;
    if (condition === 'false') return false;
    
    // Check if any input has data
    return Object.keys(data).length > 0;
  }

  async executeTransform(node, inputData, stepId) {
    // Transform data using the specified transformation
    const transformation = node.config?.transformation || 'passthrough';
    await this.log('info', `Applying transformation: ${transformation}`, { inputData }, stepId);
    
    switch (transformation) {
      case 'passthrough':
        return inputData;
      
      case 'merge':
        // Merge all inputs into one object
        return Object.assign({}, ...Object.values(inputData));
      
      case 'extract':
        // Extract specific fields
        const fields = node.config?.fields || [];
        const result = {};
        fields.forEach(field => {
          if (inputData[field]) result[field] = inputData[field];
        });
        return result;
      
      default:
        return inputData;
    }
  }
}

export default FlowExecutor;
