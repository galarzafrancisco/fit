import { All, Controller, Post, Req, Res } from '@nestjs/common';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Request, Response } from 'express';
import { Protected } from '../auth/protected.decorator';
import { AuthenticatedUser } from '../auth/user.guard';
import type { CurrentUser } from '../users/users.service';
import { FitMcpServerFactory } from './fit-mcp.server';

/**
 * Streamable HTTP MCP endpoint, stateless: each POST gets a fresh server
 * bound to the user of its access token, as Taico's own MCP gateways do.
 */
@Controller('mcp')
@Protected()
export class McpController {
  constructor(private readonly factory: FitMcpServerFactory) {}

  @Post()
  async handle(@AuthenticatedUser() user: CurrentUser, @Req() req: Request, @Res() res: Response): Promise<void> {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = this.factory.build(user);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req as never, res as never, req.body);
  }

  /** No sessions and no server-sent stream in stateless mode */
  @All()
  notAllowed(@Res() res: Response): void {
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  }
}
