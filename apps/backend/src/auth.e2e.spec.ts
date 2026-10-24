import { BASE_URL, ISSUER, callTool, connectStrava, createTestApp, mcpRequest, type TestApp } from './test-support/test-app';

describe('Taico federated auth and user isolation', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });

  it('serves health without auth', async () => {
    const res = await test.http.get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', webhooks: { pending: 0, processing: 0, failed: 0 } });
  });

  it('answers 401 with a resource-metadata challenge on /mcp and /api without a token', async () => {
    const mcp = await test.http.post('/mcp').send({});
    expect(mcp.status).toBe(401);
    expect(mcp.headers['www-authenticate']).toContain('resource_metadata=');
    await test.http.get('/api/activities').expect(401);
  });

  it('publishes protected-resource metadata pointing at Taico', async () => {
    const res = await test.http.get('/.well-known/oauth-protected-resource/mcp').expect(200);
    expect(res.body).toMatchObject({ resource: `${BASE_URL}/mcp`, authorization_servers: [ISSUER] });
  });

  it('accepts a Taico token minted for the MCP resource and maps it to a user', async () => {
    const token = await test.token({ subject: 'alice', claims: { email: 'alice@example.test' } });
    const result = await callTool(test, token, 'whoami');
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({ issuer: ISSUER, subject: 'alice', email: 'alice@example.test' });
  });

  it('refuses tokens for the wrong audience, issuer, key or expiry', async () => {
    const wrongAudience = await test.token({ audience: 'https://elsewhere.test/mcp' });
    expect((await mcpRequest(test, wrongAudience, 'tools/list')).status).toBe(401);
    // A token for the REST API is not accepted on MCP, and vice versa
    const apiToken = await test.token({ audience: test.config.auth.apiResourceUrl });
    expect((await mcpRequest(test, apiToken, 'tools/list')).status).toBe(401);
    await test.http.get('/api/me').set('Authorization', `Bearer ${apiToken}`).expect(200);
    const mcpToken = await test.token();
    await test.http.get('/api/me').set('Authorization', `Bearer ${mcpToken}`).expect(401);
    expect((await mcpRequest(test, await test.token({ issuer: 'https://evil.test' }), 'tools/list')).status).toBe(401);
    expect((await mcpRequest(test, await test.token({ foreignKey: true }), 'tools/list')).status).toBe(401);
    expect((await mcpRequest(test, await test.token({ expiresInSeconds: -60 }), 'tools/list')).status).toBe(401);
  });

  it("never shows one user's data to another", async () => {
    const alice = await test.token({ subject: 'alice' });
    const bob = await test.token({ subject: 'bob' });
    test.strava.addActivity('1001', { id: 555001, name: "Alice's secret run" });
    const callback = await connectStrava(test, alice, '1001');
    expect(callback.status).toBe(200);

    const aliceList = await callTool(test, alice, 'list_activities');
    expect(aliceList.data.items.map((a: any) => a.name)).toEqual(["Alice's secret run"]);
    const activityId = aliceList.data.items[0].id;

    const bobList = await callTool(test, bob, 'list_activities');
    expect(bobList.data.items).toEqual([]);
    const bobGet = await callTool(test, bob, 'get_activity', { activityId });
    expect(bobGet.isError).toBe(true);
    expect(bobGet.data.error.code).toBe('not_found');
    const bobApi = await test.http
      .get(`/api/activities/${activityId}`)
      .set('Authorization', `Bearer ${await test.token({ subject: 'bob', audience: test.config.auth.apiResourceUrl })}`);
    expect(bobApi.status).toBe(404);
    const bobSummary = await callTool(test, bob, 'get_activity_summary', { groupBy: 'none' });
    expect(bobSummary.data.totals.count).toBe(0);
    const bobConnections = await callTool(test, bob, 'list_connections');
    expect(bobConnections.data.find((c: any) => c.provider === 'strava').status).toBe('not_connected');
  });

  it('a user cannot pick another identity through tool arguments', async () => {
    const bob = await test.token({ subject: 'bob' });
    const result = await callTool(test, bob, 'list_activities', { userId: 'alice', subject: 'alice' } as never);
    // Unknown keys are stripped by the tool schema; the user comes from the token only
    expect(result.isError).toBe(false);
    expect(result.data.items).toEqual([]);
  });
});
