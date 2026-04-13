import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./http-common.js", () => ({
  readJsonBodyOrError: vi.fn(),
  sendJson: vi.fn(),
}));

vi.mock("../agents/auth-profiles/profiles.js", () => ({
  upsertAuthProfileWithLock: vi.fn(),
}));

const { readJsonBodyOrError, sendJson } = await import("./http-common.js");
const { upsertAuthProfileWithLock } = await import("../agents/auth-profiles/profiles.js");
const {
  handleOAuthStart,
  handleOAuthCallback,
  handleOAuthProvidersList,
  registerOAuthProvider,
  unregisterOAuthProvider,
} = await import("./oauth-proxy.js");

function createRequest(method = "POST"): IncomingMessage {
  return {
    url: "/v1/management/oauth/start",
    method,
    headers: { host: "localhost", "content-type": "application/json" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

const res = {} as ServerResponse;

const TEST_PROVIDER = {
  provider: "test-provider",
  authorizeUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  scopes: ["openid", "profile"],
  redirectUri: "https://app.example.com/oauth/callback",
  userinfoUrl: "https://auth.example.com/userinfo",
};

describe("oauth-proxy", () => {
  beforeEach(() => {
    vi.mocked(sendJson).mockReset();
    vi.mocked(readJsonBodyOrError).mockReset();
    vi.mocked(upsertAuthProfileWithLock).mockReset();
    registerOAuthProvider(TEST_PROVIDER);
  });

  afterEach(() => {
    unregisterOAuthProvider("test-provider");
  });

  // -------------------------------------------------------------------------
  // handleOAuthStart
  // -------------------------------------------------------------------------

  describe("handleOAuthStart", () => {
    it("returns 400 when body is missing", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue(undefined);
      await handleOAuthStart(createRequest(), res);
      expect(sendJson).not.toHaveBeenCalled();
    });

    it("returns 400 when provider is missing", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({});
      await handleOAuthStart(createRequest(), res);
      expect(sendJson).toHaveBeenCalledWith(
        res,
        400,
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "invalid_request" }),
        }),
      );
    });

    it("returns 400 for unknown provider without inline config", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ provider: "nonexistent" });
      await handleOAuthStart(createRequest(), res);
      expect(sendJson).toHaveBeenCalledWith(
        res,
        400,
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: "unknown_provider" }),
        }),
      );
    });

    it("returns authUrl and state for registered provider", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ provider: "test-provider" });
      await handleOAuthStart(createRequest(), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        200,
        expect.objectContaining({ ok: true }),
      );

      const payload = vi.mocked(sendJson).mock.calls[0]![2] as {
        ok: boolean;
        result: { authUrl: string; state: string; provider: string; redirectUri: string };
      };
      expect(payload.result.provider).toBe("test-provider");
      expect(payload.result.state).toBeTruthy();
      expect(payload.result.redirectUri).toBe(TEST_PROVIDER.redirectUri);
      expect(payload.result.authUrl).toContain(TEST_PROVIDER.authorizeUrl);
      expect(payload.result.authUrl).toContain("client_id=test-client-id");
      expect(payload.result.authUrl).toContain("code_challenge=");
      expect(payload.result.authUrl).toContain("code_challenge_method=S256");
      expect(payload.result.authUrl).toContain(`state=${payload.result.state}`);
    });

    it("allows frontend to override redirectUri", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({
        provider: "test-provider",
        redirectUri: "https://other-app.example.com/cb",
      });
      await handleOAuthStart(createRequest(), res);

      const payload = vi.mocked(sendJson).mock.calls[0]![2] as {
        result: { redirectUri: string; authUrl: string };
      };
      expect(payload.result.redirectUri).toBe("https://other-app.example.com/cb");
      expect(payload.result.authUrl).toContain(
        encodeURIComponent("https://other-app.example.com/cb"),
      );
    });

    it("accepts ad-hoc inline provider config", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({
        provider: "adhoc-provider",
        authorizeUrl: "https://adhoc.example.com/authorize",
        tokenUrl: "https://adhoc.example.com/token",
        clientId: "adhoc-client",
        scopes: ["email"],
        redirectUri: "https://adhoc-app.example.com/callback",
      });
      await handleOAuthStart(createRequest(), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        200,
        expect.objectContaining({ ok: true }),
      );
      const payload = vi.mocked(sendJson).mock.calls[0]![2] as {
        result: { provider: string; authUrl: string };
      };
      expect(payload.result.provider).toBe("adhoc-provider");
      expect(payload.result.authUrl).toContain("adhoc.example.com");
    });

    it("generates unique state tokens per request", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ provider: "test-provider" });

      await handleOAuthStart(createRequest(), res);
      await handleOAuthStart(createRequest(), res);

      const state1 = (vi.mocked(sendJson).mock.calls[0]![2] as { result: { state: string } })
        .result.state;
      const state2 = (vi.mocked(sendJson).mock.calls[1]![2] as { result: { state: string } })
        .result.state;
      expect(state1).not.toBe(state2);
    });
  });

  // -------------------------------------------------------------------------
  // handleOAuthCallback
  // -------------------------------------------------------------------------

  describe("handleOAuthCallback", () => {
    async function startFlow(): Promise<{ state: string }> {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ provider: "test-provider" });
      await handleOAuthStart(createRequest(), res);
      const payload = vi.mocked(sendJson).mock.calls[0]![2] as {
        result: { state: string };
      };
      vi.mocked(sendJson).mockReset();
      vi.mocked(readJsonBodyOrError).mockReset();
      return { state: payload.result.state };
    }

    it("returns 400 when body is missing", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue(undefined);
      await handleOAuthCallback(createRequest(), res);
      expect(sendJson).not.toHaveBeenCalled();
    });

    it("returns 400 when state or code is missing", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state: "abc" });
      await handleOAuthCallback(createRequest(), res);
      expect(sendJson).toHaveBeenCalledWith(
        res,
        400,
        expect.objectContaining({
          error: expect.objectContaining({ code: "invalid_request" }),
        }),
      );
    });

    it("returns 400 for unknown/expired state", async () => {
      vi.mocked(readJsonBodyOrError).mockResolvedValue({
        state: "nonexistent-state",
        code: "auth-code-123",
      });
      await handleOAuthCallback(createRequest(), res);
      expect(sendJson).toHaveBeenCalledWith(
        res,
        400,
        expect.objectContaining({
          error: expect.objectContaining({ code: "invalid_state" }),
        }),
      );
    });

    it("exchanges code for tokens and saves profile on success", async () => {
      const { state } = await startFlow();

      // Mock the global fetch for the token exchange and userinfo calls.
      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "access-tok-123",
              refresh_token: "refresh-tok-456",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ email: "user@example.com", sub: "user-123" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );

      vi.mocked(upsertAuthProfileWithLock).mockResolvedValue(null);
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "auth-code-xyz" });

      await handleOAuthCallback(createRequest(), res);

      // Verify token exchange was called with correct params.
      expect(fetchSpy).toHaveBeenCalledWith(
        TEST_PROVIDER.tokenUrl,
        expect.objectContaining({ method: "POST" }),
      );

      // Verify the token exchange body includes PKCE verifier and code.
      const tokenCallBody = fetchSpy.mock.calls[0]![1]!.body as URLSearchParams;
      expect(tokenCallBody.get("code")).toBe("auth-code-xyz");
      expect(tokenCallBody.get("grant_type")).toBe("authorization_code");
      expect(tokenCallBody.get("client_id")).toBe("test-client-id");
      expect(tokenCallBody.get("client_secret")).toBe("test-client-secret");
      expect(tokenCallBody.get("code_verifier")).toBeTruthy();

      // Verify userinfo was fetched.
      expect(fetchSpy).toHaveBeenCalledWith(
        TEST_PROVIDER.userinfoUrl,
        expect.objectContaining({
          headers: { Authorization: "Bearer access-tok-123" },
        }),
      );

      // Verify profile was saved.
      expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: expect.objectContaining({
            type: "oauth",
            provider: "test-provider",
            access: "access-tok-123",
            refresh: "refresh-tok-456",
            email: "user@example.com",
          }),
        }),
      );

      // Verify success response.
      expect(sendJson).toHaveBeenCalledWith(
        res,
        200,
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            provider: "test-provider",
            email: "user@example.com",
          }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it("state is single-use (second callback with same state fails)", async () => {
      const { state } = await startFlow();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "tok",
              refresh_token: "ref",
              expires_in: 3600,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        );
      vi.mocked(upsertAuthProfileWithLock).mockResolvedValue(null);

      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "code1" });
      await handleOAuthCallback(createRequest(), res);
      expect(sendJson).toHaveBeenCalledWith(res, 200, expect.objectContaining({ ok: true }));

      // Second attempt with same state.
      vi.mocked(sendJson).mockReset();
      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "code2" });
      await handleOAuthCallback(createRequest(), res);
      expect(sendJson).toHaveBeenCalledWith(
        res,
        400,
        expect.objectContaining({
          error: expect.objectContaining({ code: "invalid_state" }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it("returns 502 when token exchange fails", async () => {
      const { state } = await startFlow();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValueOnce(
        new Response("invalid_grant", { status: 400 }),
      );

      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "bad-code" });
      await handleOAuthCallback(createRequest(), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        502,
        expect.objectContaining({
          error: expect.objectContaining({ code: "token_exchange_failed" }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it("returns 502 when fetch throws", async () => {
      const { state } = await startFlow();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy.mockRejectedValueOnce(new Error("network error"));

      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "code" });
      await handleOAuthCallback(createRequest(), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        502,
        expect.objectContaining({
          error: expect.objectContaining({ code: "token_exchange_error" }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it("returns 502 when no access_token in response", async () => {
      const { state } = await startFlow();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } }),
      );

      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "code" });
      await handleOAuthCallback(createRequest(), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        502,
        expect.objectContaining({
          error: expect.objectContaining({ code: "no_access_token" }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it("returns 500 when profile save fails", async () => {
      const { state } = await startFlow();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ email: "x@y.com" }), { status: 200 }),
        );
      vi.mocked(upsertAuthProfileWithLock).mockRejectedValue(new Error("disk full"));

      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "code" });
      await handleOAuthCallback(createRequest(), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        500,
        expect.objectContaining({
          error: expect.objectContaining({ code: "profile_save_failed" }),
        }),
      );

      fetchSpy.mockRestore();
    });

    it("uses custom profileId when provided in start request", async () => {
      // Start with custom profileId.
      vi.mocked(readJsonBodyOrError).mockResolvedValue({
        provider: "test-provider",
        profileId: "my-custom-profile",
      });
      await handleOAuthStart(createRequest(), res);
      const state = (
        vi.mocked(sendJson).mock.calls[0]![2] as { result: { state: string } }
      ).result.state;

      vi.mocked(sendJson).mockReset();
      vi.mocked(readJsonBodyOrError).mockReset();

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      fetchSpy
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ access_token: "tok", refresh_token: "ref", expires_in: 3600 }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({}), { status: 200 }),
        );
      vi.mocked(upsertAuthProfileWithLock).mockResolvedValue(null);

      vi.mocked(readJsonBodyOrError).mockResolvedValue({ state, code: "code" });
      await handleOAuthCallback(createRequest(), res);

      expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "my-custom-profile" }),
      );

      fetchSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // handleOAuthProvidersList
  // -------------------------------------------------------------------------

  describe("handleOAuthProvidersList", () => {
    it("lists registered providers", () => {
      handleOAuthProvidersList(createRequest("GET"), res);

      expect(sendJson).toHaveBeenCalledWith(
        res,
        200,
        expect.objectContaining({
          ok: true,
          result: {
            providers: expect.arrayContaining([
              expect.objectContaining({
                provider: "test-provider",
                authorizeUrl: TEST_PROVIDER.authorizeUrl,
                scopes: TEST_PROVIDER.scopes,
              }),
            ]),
          },
        }),
      );
    });

    it("returns empty list when no providers registered", () => {
      unregisterOAuthProvider("test-provider");
      handleOAuthProvidersList(createRequest("GET"), res);

      const payload = vi.mocked(sendJson).mock.calls[0]![2] as {
        result: { providers: unknown[] };
      };
      expect(payload.result.providers).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // registerOAuthProvider / unregisterOAuthProvider
  // -------------------------------------------------------------------------

  describe("provider registry", () => {
    it("register and unregister", () => {
      registerOAuthProvider({ ...TEST_PROVIDER, provider: "temp-provider" });
      handleOAuthProvidersList(createRequest("GET"), res);
      const payload1 = vi.mocked(sendJson).mock.calls[0]![2] as {
        result: { providers: { provider: string }[] };
      };
      expect(payload1.result.providers.map((p) => p.provider)).toContain("temp-provider");

      vi.mocked(sendJson).mockReset();
      unregisterOAuthProvider("temp-provider");
      handleOAuthProvidersList(createRequest("GET"), res);
      const payload2 = vi.mocked(sendJson).mock.calls[0]![2] as {
        result: { providers: { provider: string }[] };
      };
      expect(payload2.result.providers.map((p) => p.provider)).not.toContain("temp-provider");
    });
  });
});
