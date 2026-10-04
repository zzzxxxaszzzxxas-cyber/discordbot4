process.env.ENCRYPTION_KEY = "test-encryption-key-must-be-32-bytes-long!";

const crypto = require("node:crypto");
const manager = require("../discord/core/oauthTokenManager");
const { encryptToken } = require("../discord/verification/utils/crypto");

function legacyServiceKey(secret) {
    return Buffer.from(
        crypto.createHash("sha256").update(secret).digest("base64").substring(0, 32)
    );
}

function encryptLegacy(value, secret = process.env.ENCRYPTION_KEY) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyServiceKey(secret), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v2:gcm:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function freshQuery(getValue) {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(() => Promise.resolve(getValue()))
  };
  return query;
}

function scanQuery(docs) {
  const query = {
    select: jest.fn(() => query),
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn(() => Promise.resolve(docs)),
    then: (resolve, reject) => Promise.resolve(docs).then(resolve, reject)
  };
  return query;
}

beforeEach(() => {
  manager._test.resetInternalStateForTesting();
});

test("oauthTokenManager: config resolves redirect URIs for verification and legacy admin", () => {
  const config = manager.getOAuthRefreshConfig({
    PUBLIC_BASE_URL: "https://example.com",
    LEGACY_ADMIN_OAUTH_REDIRECT_URI: "https://legacy.example/admin"
  });

  expect(config.verificationRedirectUri).toBe("https://example.com/auth/callback");
  expect(config.adminRedirectUri).toBe("https://legacy.example/admin");
});

test("oauthTokenManager: validateTokenData rejects invalid or malformed tokens", () => {
  expect(() => manager.validateTokenData(null)).toThrow();
  expect(() => manager.validateTokenData({})).toThrow();
  expect(() => manager.validateTokenData({ access_token: "a" })).toThrow();
  expect(() => manager.validateTokenData({ access_token: "a", refresh_token: "r", expires_in: -1 })).toThrow();
  expect(() => manager.validateTokenData({ access_token: "a", refresh_token: "r", expires_in: "nan" })).toThrow();
  expect(manager.validateTokenData({ access_token: "a", refresh_token: "r", expires_in: 3600 })).toBe(true);
});

test("oauthTokenManager: prepareStoredToken encrypts tokens and calculates expiresAt", () => {
  const now = 10000;
  const stored = manager.prepareStoredToken(
    {
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      expires_in: 3600,
      scope: "identify guilds",
      token_type: "Bearer"
    },
    { now, previousVersion: 3 }
  );

  expect(stored.encryptedAccessToken).toMatch(/^v3:gcm:/);
  expect(stored.encryptedRefreshToken).toMatch(/^v3:gcm:/);
  expect(stored.expiresAt).toBe(now + 3600 * 1000);
  expect(stored.version).toBe(4);
  expect(stored.refreshFailCount).toBe(0);
  expect(stored.lastRefreshError).toBeNull();
  expect(stored.revokedAt).toBeNull();
});

test("oauthTokenManager: commitVerificationActivation atomically updates snapshot and encrypted token", async () => {
  let capturedFilter = null;
  let capturedUpdate = null;
  const model = {
    findOneAndUpdate: jest.fn((filter, update, options) => {
      capturedFilter = filter;
      capturedUpdate = update;
      return Promise.resolve({ _id: "doc1", ...update.$set });
    })
  };

  const result = await manager.commitVerificationActivation({
    profileUserId: "u123",
    tokenData: {
      access_token: "my-access",
      refresh_token: "my-refresh",
      expires_in: 7200,
      scope: "identify guilds.join"
    },
    updateSet: { "discord.username": "testuser" },
    safeAttemptStartedAt: 5000,
    existing: null,
    storedSnapshots: { version: 1 },
    model,
    now: 6000
  });

  expect(result.ok).toBe(true);
  expect(capturedFilter["discord.userId"]).toBe("u123");
  expect(capturedUpdate.$set.oauth.encryptedAccessToken).toMatch(/^v3:gcm:/);
  expect(capturedUpdate.$set.oauth.encryptedRefreshToken).toMatch(/^v3:gcm:/);
  expect(capturedUpdate.$set.oauth.version).toBe(1);
  expect(capturedUpdate.$set["discord.username"]).toBe("testuser");
});

test("oauthTokenManager: getAccessToken returns cached active token if not expired", async () => {
  const encAccess = encryptToken("plain-access-token");
  const encRefresh = encryptToken("plain-refresh-token");
  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({
          discord: { userId: "u1" },
          oauth: {
            encryptedAccessToken: encAccess,
            encryptedRefreshToken: encRefresh,
            expiresAt: Date.now() + 1000000,
            revokedAt: null
          }
        })
      })
    }))
  };

  const result = await manager.getAccessToken({
    userId: "u1",
    model,
    now: Date.now()
  });

  expect(result.ok).toBe(true);
  expect(result.accessToken).toBe("plain-access-token");
  expect(result.refreshed).toBe(false);
});

test("oauthTokenManager: getAccessToken triggers refresh under lock when token is near expiry", async () => {
  const encAccess = encryptToken("old-access");
  const encRefresh = encryptToken("old-refresh");
  const now = 10000;
  let updateFilter = null;
  let updateSet = null;

  const doc = {
    _id: "doc1",
    discord: { userId: "u1" },
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      expiresAt: now + 60000, // within margin
      version: 1
    }
  };

  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(structuredClone(doc))
      })
    })),
    findById: jest.fn(() => freshQuery(() => structuredClone(doc))),
    updateOne: jest.fn((filter, update) => {
      updateFilter = filter;
      updateSet = update;
      return Promise.resolve({ modifiedCount: 1 });
    })
  };

  const discord = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600
    }))
  };

  const result = await manager.getAccessToken({
    userId: "u1",
    model,
    discord,
    now,
    marginMs: 300000
  });

  expect(result.ok).toBe(true);
  expect(result.accessToken).toBe("new-access");
  expect(result.refreshed).toBe(true);
  expect(discord.refreshToken).toHaveBeenCalledWith("old-refresh", expect.any(String));
  expect(updateFilter["oauth.encryptedRefreshToken"]).toBe(encRefresh);
  expect(updateFilter["oauth.version"]).toBe(1);
  expect(updateSet.$set.oauth.version).toBe(2);
});

test("oauthTokenManager: concurrent getAccessToken calls deduplicate and call provider only once", async () => {
  const encAccess = encryptToken("old-access");
  const encRefresh = encryptToken("old-refresh");
  const now = 10000;

  const doc = {
    _id: "doc1",
    discord: { userId: "u1" },
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      expiresAt: now - 100, // expired
      version: 1
    }
  };

  let updatedDoc = null;
  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(structuredClone(updatedDoc || doc))
      })
    })),
    findById: jest.fn(() => freshQuery(() => structuredClone(updatedDoc || doc))),
    updateOne: jest.fn((filter, update) => {
      updatedDoc = {
        _id: "doc1",
        discord: { userId: "u1" },
        oauth: {
          ...update.$set.oauth
        }
      };
      return Promise.resolve({ modifiedCount: 1 });
    })
  };

  const discord = {
    refreshToken: jest.fn(async () => {
      await new Promise(r => setTimeout(r, 20));
      return {
        access_token: "brand-new-access",
        refresh_token: "brand-new-refresh",
        expires_in: 7200
      };
    })
  };

  const [res1, res2, res3] = await Promise.all([
    manager.getAccessToken({ userId: "u1", model, discord, now }),
    manager.getAccessToken({ userId: "u1", model, discord, now }),
    manager.getAccessToken({ userId: "u1", model, discord, now })
  ]);

  expect(discord.refreshToken).toHaveBeenCalledTimes(1);
  expect(res1.accessToken).toBe("brand-new-access");
  expect(res2.accessToken).toBe("brand-new-access");
  expect(res3.accessToken).toBe("brand-new-access");
});

test("oauthTokenManager: refreshDueTokens scans expiring tokens across oauth and adminOAuth", async () => {
  const encRefresh1 = encryptToken("refresh-1");
  const encRefresh2 = encryptToken("refresh-2");
  const now = 50000;

  const oauthDoc = {
    _id: "doc-oauth",
    discord: { userId: "user-oauth" },
    oauth: {
      encryptedRefreshToken: encRefresh1,
      expiresAt: now + 1000,
      version: 1
    }
  };

  const adminDoc = {
    _id: "doc-admin",
    discord: { userId: "user-admin" },
    adminOAuth: {
      encryptedRefreshToken: encRefresh2,
      expiresAt: now + 2000,
      version: 5
    }
  };

  const model = {
    find: jest.fn((query) => {
      if (query["oauth.encryptedRefreshToken"]) return scanQuery([oauthDoc]);
      if (query["adminOAuth.encryptedRefreshToken"]) return scanQuery([adminDoc]);
      return scanQuery([]);
    }),
    findById: jest.fn((id) => {
      if (String(id) === "doc-oauth") return freshQuery(() => structuredClone(oauthDoc));
      if (String(id) === "doc-admin") return freshQuery(() => structuredClone(adminDoc));
      return freshQuery(() => null);
    }),
    updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 }))
  };

  const discord = {
    refreshToken: jest.fn((token, redirectUri) => Promise.resolve({
      access_token: `access-for-${token}`,
      refresh_token: `new-${token}`,
      expires_in: 3600
    }))
  };

  const summary = await manager.refreshDueTokens({
    OAuthUserModel: model,
    discordApi: discord,
    now,
    marginMs: 5000
  });

  expect(summary.scanned).toBe(2);
  expect(summary.refreshed).toBe(2);
  expect(summary.failed).toBe(0);
  expect(discord.refreshToken).toHaveBeenCalledTimes(2);
});

test("oauthTokenManager: listAccessTokenCandidates prioritizes oauth over adminOAuth and excludes sensitive tokens", async () => {
  const encRefresh = encryptToken("valid-refresh");
  const docs = [
    {
      _id: "doc1",
      discord: { userId: "user1" },
      oauth: {
        encryptedRefreshToken: encRefresh,
        scope: "identify guilds.join",
        revokedAt: null,
        refreshFailCount: 0
      },
      adminOAuth: {
        encryptedRefreshToken: encRefresh,
        scope: "identify guilds.join",
        revokedAt: null
      }
    },
    {
      _id: "doc2",
      discord: { userId: "user2" },
      oauth: {
        encryptedRefreshToken: encRefresh,
        scope: "identify email", // missing guilds.join
        revokedAt: null
      },
      adminOAuth: {
        encryptedRefreshToken: encRefresh,
        scope: "identify guilds.join",
        revokedAt: null
      }
    }
  ];

  const model = {
    find: jest.fn(() => scanQuery(docs))
  };

  const candidates = await manager.listAccessTokenCandidates({
    requiredScopes: ["guilds.join"],
    model
  });

  expect(candidates.length).toBe(2);
  expect(candidates[0]).toEqual({
    userId: "user1",
    tokenField: "oauth",
    scope: "identify guilds.join",
    recordId: "doc1"
  });
  expect(candidates[1]).toEqual({
    userId: "user2",
    tokenField: "adminOAuth",
    scope: "identify guilds.join",
    recordId: "doc2"
  });
  expect(candidates[0].encryptedAccessToken).toBeUndefined();
  expect(candidates[0].accessToken).toBeUndefined();
});

test("oauthTokenManager: getOwnerTokenState decrypts and returns full raw tokens for Owner Detail (OI-03)", async () => {
  const encAccess = encryptToken("owner-raw-access");
  const encRefresh = encryptToken("owner-raw-refresh");

  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({
          discord: { userId: "target-user" },
          oauth: {
            encryptedAccessToken: encAccess,
            encryptedRefreshToken: encRefresh,
            scope: "identify guilds",
            tokenType: "Bearer",
            expiresAt: 50000,
            rawTokenMeta: { receivedAt: 10000 }
          }
        })
      })
    }))
  };

  const ownerState = await manager.getOwnerTokenState("target-user", { model });

  expect(ownerState.oauth.accessToken).toBe("owner-raw-access");
  expect(ownerState.oauth.refreshToken).toBe("owner-raw-refresh");
  expect(ownerState.oauth.lifetimeMs).toBe(40000);
});

test("oauthTokenManager: getRecoveryStatuses evaluates token health without leaking plaintext tokens", async () => {
  const encAccess = encryptToken("valid-access");

  const model = {
    find: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve([
          {
            discord: { userId: "user-broken" },
            oauth: {
              encryptedAccessToken: encAccess,
              // missing refresh token
              expiresAt: 1000,
              scope: "identify" // missing email, guilds
            }
          }
        ])
      })
    }))
  };

  const statuses = await manager.getRecoveryStatuses(["user-broken"], {
    model,
    now: 5000,
    requiredScopes: ["identify", "email", "guilds"]
  });

  const broken = statuses.get("user-broken");
  expect(broken).toBeDefined();
  expect(broken.reasons).toContain("missing_refresh_token");
  expect(broken.reasons).toContain("access_token_expired_without_refresh");
  expect(broken.reasons).toContain("missing_scope:email");
  expect(broken.reasons).toContain("missing_scope:guilds");
});

test("oauthTokenManager: migrateStoredTokenEncryption upgrades non-v3 tokens", async () => {
  const legacyEnc = encryptLegacy("legacy-token-secret-12345");
  const doc = {
    _id: "doc-legacy",
    oauth: {
      encryptedAccessToken: legacyEnc
    }
  };

  let updateSet = null;
  const model = {
    find: jest.fn(() => ({
      limit: () => Promise.resolve([doc])
    })),
    updateOne: jest.fn((filter, update) => {
      updateSet = update.$set;
      return Promise.resolve({ modifiedCount: 1 });
    })
  };

  const summary = await manager.migrateStoredTokenEncryption({
    dryRun: false,
    model
  });

  expect(summary.scanned).toBe(1);
  expect(summary.updated).toBe(1);
  expect(updateSet["oauth.encryptedAccessToken"]).toMatch(/^v3:gcm:/);
});

test("oauthTokenManager: start, stop, and getDiagnostics track lifecycle cleanly", async () => {
  const model = {
    find: jest.fn(() => scanQuery([]))
  };

  const diagStart = await manager.start({
    OAuthUserModel: model,
    intervalMs: 60000
  });

  expect(diagStart.running).toBe(true);
  expect(diagStart.timerActive).toBe(true);

  const diagStop = await manager.stop();
  expect(diagStop.running).toBe(false);
  expect(diagStop.timerActive).toBe(false);
});

test("oauthTokenManager: buildRefreshQuery selects stored tokens that are close to expiry", () => {
  const query = manager._test.buildRefreshQuery(1000, 500, 5);
  expect(query.$or[0]["oauth.expiresAt"].$lte).toBe(1500);
  expect(query["oauth.encryptedRefreshToken"].$exists).toBe(true);
  expect(query.$and[0].$or[1]["oauth.refreshFailCount"].$lt).toBe(5);

  const adminQuery = manager._test.buildRefreshQuery(1000, 500, 5, "adminOAuth");
  expect(adminQuery.$or[0]["adminOAuth.expiresAt"].$lte).toBe(1500);
  expect(adminQuery["adminOAuth.encryptedRefreshToken"].$exists).toBe(true);
});

test("oauthTokenManager: refresh persistence conflicts are skipped without incrementing failure state", async () => {
  const encRefresh = encryptToken("refresh-old");
  const doc = {
    _id: "doc-conflict",
    discord: { userId: "user-conflict" },
    oauth: {
      encryptedRefreshToken: encRefresh,
      expiresAt: 1000,
      refreshFailCount: 0,
      version: 4
    }
  };
  const model = {
    findById: jest.fn(() => freshQuery(() => structuredClone(doc))),
    updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 0 }))
  };
  const discord = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 604800
    }))
  };

  const outcome = await manager._test.performTokenRefreshUnderLock({
    doc,
    model,
    discord,
    redirectUri: "https://example.com/auth/callback",
    now: 5000,
    failMax: 5,
    tokenField: "oauth",
    force: true
  });

  expect(outcome).toMatchObject({ ok: true, skipped: true, reason: "refresh_state_changed" });
  expect(model.updateOne).toHaveBeenCalledTimes(1);
});

test("oauthTokenManager: revokeToken marks revokedAt in MongoDB and calls Discord API", async () => {
  const encRefresh = encryptToken("refresh-to-revoke");
  let saved = false;
  const doc = {
    _id: "doc-revoke",
    discord: { userId: "user-to-revoke" },
    oauth: {
      encryptedRefreshToken: encRefresh,
      revokedAt: null
    },
    save: jest.fn(() => {
      saved = true;
      return Promise.resolve();
    })
  };

  const model = {
    findOne: jest.fn(() => ({
      select: () => Promise.resolve(doc)
    }))
  };

  const discord = {
    revokeToken: jest.fn(() => Promise.resolve({ ok: true }))
  };

  const result = await manager.revokeToken({
    userId: "user-to-revoke",
    model,
    discord,
    now: 77777
  });

  expect(result.ok).toBe(true);
  expect(result.revoked).toBe(true);
  expect(saved).toBe(true);
  expect(doc.oauth.revokedAt).toBe(77777);
  expect(discord.revokeToken).toHaveBeenCalledWith("refresh-to-revoke", "refresh_token");
});
