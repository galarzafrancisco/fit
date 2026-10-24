import { createTestApp, mcpRequest, type TestApp } from './test-support/test-app';

describe('MCP interface', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });

  it('initializes and advertises instructions', async () => {
    const res = await mcpRequest(test, await test.token(), 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe('fit');
    expect(res.body.result.instructions).toContain('Strava and Garmin');
  });

  it('lists the tools with read-only annotations where they apply', async () => {
    const res = await mcpRequest(test, await test.token(), 'tools/list');
    const tools = Object.fromEntries(res.body.result.tools.map((t: any) => [t.name, t]));
    expect(Object.keys(tools).sort()).toEqual(
      [
        'connect_provider',
        'disconnect_provider',
        'get_activity',
        'get_activity_summary',
        'list_activities',
        'list_connections',
        'list_sync_runs',
        'list_webhook_events',
        'sync_provider',
        'whoami',
      ].sort(),
    );
    for (const name of ['list_activities', 'get_activity', 'get_activity_summary', 'list_connections', 'list_sync_runs', 'list_webhook_events', 'whoami']) {
      expect(tools[name].annotations.readOnlyHint).toBe(true);
    }
    expect(tools.disconnect_provider.annotations.destructiveHint).toBe(true);
    expect(tools.list_activities.inputSchema.properties.sportGroup.enum).toContain('cycling');
  });

  it('lists the activity resource template', async () => {
    const res = await mcpRequest(test, await test.token(), 'resources/templates/list');
    expect(res.body.result.resourceTemplates[0].uriTemplate).toBe('fit://activities/{activityId}');
  });

  it('only accepts POST', async () => {
    const res = await test.http.get('/mcp').set('Authorization', `Bearer ${await test.token()}`);
    expect(res.status).toBe(405);
  });
});
