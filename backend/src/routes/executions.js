// API routes for flow execution
import express from 'express';
import ExecutionService from '../execution/ExecutionService.js';
import { audit } from '../logging/audit.js';
import { query } from '../db/postgres.js';

const router = express.Router();

/**
 * POST /api/executions/start
 * Start a flow execution
 * Body: { flowId, triggerType?, triggerData? }
 */
router.post('/start', async (req, res) => {
  const { flowId, triggerType = 'manual', triggerData = {} } = req.body;

  if (!flowId) {
    return res.status(400).json({ error: 'flowId is required' });
  }

  try {
    const result = await ExecutionService.startExecution(flowId, triggerType, triggerData);

    await audit(req, {
      userId: req.user?.id ?? null,
      action: 'FLOW_EXECUTION_STARTED',
      targetType: 'flow',
      targetId: flowId,
      statusCode: 200,
      metadata: { executionId: result.executionId, triggerType }
    });

    res.json(result);
  } catch (error) {
    console.error('Failed to start execution:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/executions/recent
 * List recent executions for the current user's organization
 * Query: limit? (default 20)
 */
router.get('/recent', async (req, res) => {
  const orgId = req.user?.org;
  if (!orgId) return res.status(401).json({ error: 'Organization not found' });

  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const { rows } = await query(
      `SELECT e.id,
              e.flow_id           AS "flowId",
              e.flow_version      AS version,
              e.status,
              e.trigger_type      AS "triggerType",
              e.trigger_data      AS "triggerData",
              e.started_at        AS "startedAt",
              e.completed_at      AS "completedAt",
              f.name              AS "flowName"
       FROM flow_executions e
       JOIN flows f ON f.id = e.flow_id
       WHERE f.org_id = $1
       ORDER BY e.started_at DESC
       LIMIT $2`,
      [orgId, limit]
    );
    res.json(rows);
  } catch (error) {
    console.error('Failed to list recent executions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/executions/flow/:flowId
 * Get all executions for a flow
 */
router.get('/flow/:flowId', async (req, res) => {
  const { flowId } = req.params;
  const limit = parseInt(req.query.limit) || 20;

  try {
    const executions = await ExecutionService.getFlowExecutions(flowId, limit);
    res.json(executions);
  } catch (error) {
    console.error('Failed to get flow executions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/executions/:executionId
 * Get execution details
 */
router.get('/:executionId', async (req, res) => {
  const { executionId } = req.params;

  try {
    const execution = await ExecutionService.getExecution(executionId);
    res.json(execution);
  } catch (error) {
    console.error('Failed to get execution:', error);
    res.status(404).json({ error: error.message });
  }
});

/**
 * GET /api/executions/:executionId/steps
 * Get execution steps
 */
router.get('/:executionId/steps', async (req, res) => {
  const { executionId } = req.params;

  try {
    const steps = await ExecutionService.getExecutionSteps(executionId);
    res.json(steps);
  } catch (error) {
    console.error('Failed to get execution steps:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/executions/:executionId/logs
 * Get execution logs
 */
router.get('/:executionId/logs', async (req, res) => {
  const { executionId } = req.params;
  const limit = parseInt(req.query.limit) || 100;

  try {
    const logs = await ExecutionService.getExecutionLogs(executionId, limit);
    res.json(logs);
  } catch (error) {
    console.error('Failed to get execution logs:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/executions/:executionId/cancel
 * Cancel a running execution
 */
router.post('/:executionId/cancel', async (req, res) => {
  const { executionId } = req.params;

  try {
    const result = await ExecutionService.cancelExecution(executionId);

    await audit(req, {
      userId: req.user?.id ?? null,
      action: 'FLOW_EXECUTION_CANCELLED',
      targetType: 'execution',
      targetId: executionId,
      statusCode: 200
    });

    res.json(result);
  } catch (error) {
    console.error('Failed to cancel execution:', error);
    res.status(500).json({ error: error.message });
  }
});
/**
 * DELETE /api/executions/:executionId
 * Delete an execution record and all its associated data
 */
router.delete('/:executionId', async (req, res) => {
  const { executionId } = req.params;
  const orgId = req.user?.org;

  try {
    if (!orgId) return res.status(401).json({ error: 'Organization not found' });

    // Ensure this execution belongs to the user's organization
    const owned = await query(
      `SELECT e.id
       FROM flow_executions e
       JOIN flows f ON f.id = e.flow_id
       WHERE e.id = $1 AND f.org_id = $2`,
      [executionId, orgId]
    );
    if (owned.rowCount === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    // Delete execution logs first (foreign key)
    await query('DELETE FROM execution_logs WHERE execution_id = $1', [executionId]);
    
    // Delete execution steps (foreign key)
    await query('DELETE FROM execution_steps WHERE execution_id = $1', [executionId]);
    
    // Delete the execution record
    const result = await query('DELETE FROM flow_executions WHERE id = $1 RETURNING id', [executionId]);
    
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Execution not found' });
    }

    await audit(req, {
      userId: req.user?.id ?? null,
      action: 'FLOW_EXECUTION_DELETED',
      targetType: 'execution',
      targetId: executionId,
      statusCode: 200
    });

    res.json({ success: true, message: 'Execution deleted' });
  } catch (error) {
    console.error('Failed to delete execution:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
