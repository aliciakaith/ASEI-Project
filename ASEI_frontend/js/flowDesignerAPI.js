// Flow Designer API Module
const FlowAPI = {
  baseURL: '/api/flows',

  /**
   * Get all flows
   */
  async getAllFlows() {
    try {
      // default: return org-scoped flows. Pass mineOnly=true to return only flows created by the current user.
      const url = this.baseURL;
      const response = await fetch(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch flows:', error);
      throw error;
    }
  },

  // New: fetch flows with option to only return flows created by current user
  async getAllFlowsMineOnly() {
    try {
      const response = await fetch(this.baseURL + '?mine=true', {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch my flows:', error);
      throw error;
    }
  },

  /**
   * Get a specific flow by ID with its latest version
   */
  async getFlow(flowId) {
    try {
      const response = await fetch(`${this.baseURL}/${flowId}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch flow:', error);
      throw error;
    }
  },

  /**
   * Create a new flow
   */
  async createFlow(name, description = '') {
    try {
      const response = await fetch(this.baseURL, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to create flow:', error);
      throw error;
    }
  },

  /**
   * Save a flow version (graph data)
   */
  async saveFlowVersion(flowId, graph, variables = {}) {
    try {
      const response = await fetch(`${this.baseURL}/${flowId}/versions`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ graph, variables })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to save flow version:', error);
      throw error;
    }
  },

  /**
   * Get all versions of a flow
   */
  async getFlowVersions(flowId) {
    try {
      const response = await fetch(`${this.baseURL}/${flowId}/versions`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch flow versions:', error);
      throw error;
    }
  },

  /**
   * Get a specific version of a flow
   */
  async getFlowVersion(flowId, version) {
    try {
      const response = await fetch(`${this.baseURL}/${flowId}/versions/${version}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch flow version:', error);
      throw error;
    }
  },

  /**
   * Delete a flow (soft delete)
   */
  async deleteFlow(flowId) {
    try {
      const response = await fetch(`${this.baseURL}/${flowId}`, {
        method: 'DELETE',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to delete flow:', error);
      throw error;
    }
  },

  /**
   * Update flow status (for deployment)
   */
  async updateFlowStatus(flowId, status) {
    try {
      // This endpoint might need to be added to the backend
      const response = await fetch(`${this.baseURL}/${flowId}/status`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to update flow status:', error);
      throw error;
    }
  },

  /**
   * Start a manual execution of a flow
   */
  async executeFlow(flowId, triggerData = {}) {
    try {
      const response = await fetch('/api/executions/start', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          flowId, 
          triggerType: 'manual',
          triggerData 
        })
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to execute flow:', error);
      throw error;
    }
  },

  /**
   * Get execution details
   */
  async getExecution(executionId) {
    try {
      const response = await fetch(`/api/executions/${executionId}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch execution:', error);
      throw error;
    }
  },

  /**
   * Get execution steps
   */
  async getExecutionSteps(executionId) {
    try {
      const response = await fetch(`/api/executions/${executionId}/steps`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch execution steps:', error);
      throw error;
    }
  },

  /**
   * Get execution logs
   */
  async getExecutionLogs(executionId, limit = 100) {
    try {
      const response = await fetch(`/api/executions/${executionId}/logs?limit=${limit}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch execution logs:', error);
      throw error;
    }
  },

  /**
   * Get all executions for a flow
   */
  async getFlowExecutions(flowId, limit = 20) {
    try {
      const response = await fetch(`/api/executions/flow/${flowId}?limit=${limit}`, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error('Failed to fetch flow executions:', error);
      throw error;
    }
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowAPI;
}
