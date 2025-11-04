// Flow Designer API Module
const FlowAPI = {
  baseURL: '/api/flows',

  /**
   * Get all flows
   */
  async getAllFlows() {
    try {
      const response = await fetch(this.baseURL, {
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
  }
};

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowAPI;
}
