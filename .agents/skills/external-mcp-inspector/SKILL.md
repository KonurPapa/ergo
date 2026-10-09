---
name: "External MCP Connector & Tool Inspector"
description: "Inspect connected MCP servers, discover capabilities, and mobilize tools for the task."
enabled: true
triggers: ["mcp", "tools list", "external tools", "inspect mcp", "github mcp", "filesystem tools"]
---

# External MCP Connector & Tool Inspector

Inspect connected MCP servers, discover capabilities, and mobilize tools for the task.

## Rules & Constraints
Tool and server permissions or removals are strictly manual and human-controlled. You may read tools and server status, but do not attempt administrative removal.

## Instructions
When exploring or utilizing external tools:
1. Call `workspace_list_mcp_servers()` to see available connections (filesystem, github, remote APIs).
2. Call `workspace_read_mcp_tools({ serverId })` to discover exact schemas for needed tools.
3. Call specific external tools (e.g. read_file, create_issue) as required to solve the task.
