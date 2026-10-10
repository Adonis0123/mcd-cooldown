export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface ToolContent {
  type: string;
  text?: string;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  structuredContent?: unknown;
}

export interface ToolCaller {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

export interface RpcErrorBody {
  code: number;
  message: string;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: RpcErrorBody;
}
