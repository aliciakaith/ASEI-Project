// Flow Execution Service
// Manages starting, monitoring, and controlling flow executions

import { query } from '../db/postgres.js';
import FlowExecutor from './FlowExecutor.js';

class ExecutionService {
  static async startExecution(flowId, triggerType = 'manual', triggerData = {}) {
    try {
      // Get the latest version of the flow
      const flowResult = await query(
        `SELECT f.*, COALESCE(MAX(v.version), 0) as latest_version
         FROM flows f
         LEFT JOIN flow_versions v ON v.flow_id = f.id
         WHERE f.id = $1 AND f.is_deleted = FALSE
         GROUP BY f.id`,
        [flowId]
      );

      if (flowResult.rows.length === 0) {
        throw new Error('Flow not found');
      }

      const flow = flowResult.rows[0];

      if (flow.latest_version === 0) {
        throw new Error('Flow has no versions to execute');
      }

      // Create execution record
      const executionResult = await query(
        `INSERT INTO flow_executions (flow_id, flow_version, status, trigger_type, trigger_data)
         VALUES ($1, $2, 'running', $3, $4)
         RETURNING id`,
        [flowId, flow.latest_version, triggerType, JSON.stringify(triggerData)]
      );

      const executionId = executionResult.rows[0].id;

      // Start execution asynchronously
      const executor = new FlowExecutor(
        executionId,
        flowId,
        flow.latest_version,
        triggerType,
        triggerData
      );

      // Execute in background
      executor.execute().catch(error => {
        console.error('Execution error:', error);
      });

      return {
        executionId,
        flowId,
        flowName: flow.name,
        version: flow.latest_version,
        status: 'running',
        message: 'Flow execution started'
      };

    } catch (error) {
      console.error('Failed to start execution:', error);
      throw error;
    }
  }

  static async getExecution(executionId) {
    const result = await query(
      `SELECT e.*, f.name as flow_name
       FROM flow_executions e
       JOIN flows f ON f.id = e.flow_id
       WHERE e.id = $1`,
      [executionId]
    );

    if (result.rows.length === 0) {
      throw new Error('Execution not found');
    }

    return result.rows[0];
  }

  static async getExecutionSteps(executionId) {
    const result = await query(
      `SELECT * FROM execution_steps 
       WHERE execution_id = $1 
       ORDER BY started_at ASC`,
      [executionId]
    );

    return result.rows;
  }

  static async getExecutionLogs(executionId, limit = 100) {
    const result = await query(
      `SELECT * FROM execution_logs 
       WHERE execution_id = $1 
       ORDER BY created_at DESC
       LIMIT $2`,
      [executionId, limit]
    );

    return result.rows;
  }

  static async getFlowExecutions(flowId, limit = 20) {
    const result = await query(
      `SELECT * FROM flow_executions 
       WHERE flow_id = $1 
       ORDER BY started_at DESC
       LIMIT $2`,
      [flowId, limit]
    );

    return result.rows;
  }

  static async cancelExecution(executionId) {
    await query(
      `UPDATE flow_executions 
       SET status = 'cancelled', completed_at = now() 
       WHERE id = $1 AND status = 'running'`,
      [executionId]
    );

    return { success: true, message: 'Execution cancelled' };
  }
}

export default ExecutionService;
