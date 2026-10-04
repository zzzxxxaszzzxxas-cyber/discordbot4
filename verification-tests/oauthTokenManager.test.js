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

  const result = await manager.listAccessTokenCandidates({
    requiredScopes: ["guilds.join"],
    model
  });
  const candidates = result.candidates;

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

test("oauthTokenManager: revokeToken atomically sets revokedAt, increments version, and calls Discord API", async () => {
  const encRefresh = encryptToken("refresh-to-revoke");
  let updateFilter = null;
  let updatePayload = null;
  const doc = {
    _id: "doc-revoke",
    discord: { userId: "user-to-revoke" },
    oauth: {
      encryptedRefreshToken: encRefresh,
      revokedAt: null,
      version: 3
    }
  };

  const model = {
    findOne: jest.fn(() => ({
      select: () => Promise.resolve(doc)
    })),
    updateOne: jest.fn((filter, update) => {
      updateFilter = filter;
      updatePayload = update;
      return Promise.resolve({ modifiedCount: 1 });
    })
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
  expect(updateFilter).toMatchObject({ _id: "doc-revoke", "oauth.version": 3 });
  expect(updatePayload.$set["oauth.revokedAt"]).toBe(77777);
  expect(updatePayload.$inc["oauth.version"]).toBe(1);
  expect(discord.revokeToken).toHaveBeenCalledWith("refresh-to-revoke", "refresh_token");
});

test("oauthTokenManager: initial authorization leaves lastRefreshAt as null and sets receivedAt", () => {
  const stored = manager.prepareStoredToken({
    access_token: "init-access",
    refresh_token: "init-refresh",
    expires_in: 3600,
    scope: "identify guilds.join"
  }, { now: 1000, previousVersion: 0, isRefresh: false });

  expect(stored.lastRefreshAt).toBeNull();
  expect(stored.rawTokenMeta.receivedAt).toBe(1000);
  expect(stored.rawTokenMeta.expiresIn).toBe(3600);
});

test("oauthTokenManager: commitVerificationActivation validates tokenData before storing", async () => {
  const model = { findOneAndUpdate: jest.fn() };

  await expect(manager.commitVerificationActivation({
    profileUserId: "u1",
    tokenData: null,
    updateSet: {},
    model
  })).rejects.toMatchObject({ code: "oauth_token_invalid_payload" });

  await expect(manager.commitVerificationActivation({
    profileUserId: "u1",
    tokenData: { access_token: "a" },
    updateSet: {},
    model
  })).rejects.toMatchObject({ code: "oauth_token_missing_refresh_token" });

  await expect(manager.commitVerificationActivation({
    profileUserId: "u1",
    tokenData: { access_token: "a", refresh_token: "r", expires_in: -1 },
    updateSet: {},
    model
  })).rejects.toMatchObject({ code: "oauth_token_invalid_expires_in" });

  expect(model.findOneAndUpdate).not.toHaveBeenCalled();
});

test("oauthTokenManager: migrateStoredTokenEncryption accurately decrypts and re-encrypts exact plaintext (preventing object corruption bug)", async () => {
  const originalPlaintext = "legacy-token-secret-12345";
  const legacyEncrypted = encryptLegacy(originalPlaintext);

  let updatedValue = null;
  const docs = [{
    _id: "doc-mig",
    oauth: {
      encryptedAccessToken: legacyEncrypted,
      encryptedRefreshToken: "v3:gcm:already-v3"
    }
  }];

  const model = {
    find: jest.fn(() => ({
      select: () => ({
        sort: () => ({
          limit: () => ({
            lean: () => Promise.resolve(docs)
          })
        })
      })
    })),
    updateOne: jest.fn((filter, update) => {
      expect(filter).toEqual({ _id: "doc-mig", "oauth.encryptedAccessToken": legacyEncrypted });
      updatedValue = update.$set["oauth.encryptedAccessToken"];
      return Promise.resolve({ modifiedCount: 1 });
    }),
    countDocuments: jest.fn(() => Promise.resolve(0))
  };

  const summary = await manager.migrateStoredTokenEncryption({
    dryRun: false,
    model
  });

  expect(summary.migratedFields).toBe(1);
  expect(summary.failedFields).toBe(0);
  expect(updatedValue).toMatch(/^v3:gcm:/);

  // CRITICAL REGRESSION ASSERTION: decrypting the re-encrypted value MUST yield the original plaintext, NOT JSON
  const decrypted = manager._test.decryptToken(updatedValue);
  expect(decrypted).toBe(originalPlaintext);
  expect(typeof decrypted).toBe("string");
  expect(decrypted).not.toContain("needsMigration");
  expect(decrypted).not.toContain("plaintext");
});

test("oauthTokenManager: in-flight revoke prevents concurrent refresh from restoring un-revoked token", async () => {
  const encRefresh = encryptToken("refresh-concurrent");
  const doc = {
    _id: "doc-race",
    discord: { userId: "user-race" },
    oauth: {
      encryptedAccessToken: encryptToken("old-access"),
      encryptedRefreshToken: encRefresh,
      expiresAt: 100,
      version: 2,
      revokedAt: null
    }
  };

  const model = {
    findById: jest.fn(() => freshQuery(() => ({
      ...doc,
      oauth: {
        ...doc.oauth,
        // During in-flight refresh, owner revokes token:
        revokedAt: 5000,
        version: 3
      }
    }))),
    updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 0 }))
  };

  const discord = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600
    }))
  };

  const outcome = await manager._test.performTokenRefreshUnderLock({
    doc,
    model,
    discord,
    now: 6000,
    force: true
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("token_revoked");
  expect(model.updateOne).not.toHaveBeenCalled();
});

test("oauthTokenManager: getAccessToken and background query exclude soft-deleted users", async () => {
  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({
          discord: { userId: "deleted-user" },
          deletedAt: new Date(),
          oauth: {
            encryptedAccessToken: encryptToken("valid-access"),
            expiresAt: Date.now() + 60000
          }
        })
      })
    }))
  };

  const res = await manager.getAccessToken({
    userId: "deleted-user",
    model
  });

  expect(res.ok).toBe(false);
  expect(res.code).toBe("user_deleted");

  const query = manager._test.buildRefreshQuery(1000, 5000, 5, "oauth");
  expect(query.$and).toBeDefined();
  const deletedCondition = query.$and.find(c => c.$or && c.$or.some(cond => "deletedAt" in cond));
  expect(deletedCondition).toBeDefined();
});

test("oauthTokenManager: getOwnerTokenMetadata returns non-cryptographic token status DTO", async () => {
  const encAccess = encryptToken("raw-access-secret");
  const encRefresh = encryptToken("raw-refresh-secret");
  const doc = {
    discord: { userId: "user-dto" },
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      scope: "identify guilds.join",
      tokenType: "Bearer",
      expiresAt: 50000,
      lastRefreshAt: 10000,
      refreshFailCount: 0,
      revokedAt: null,
      rawTokenMeta: { receivedAt: 5000 }
    },
    adminOAuth: {}
  };

  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(doc)
      })
    }))
  };

  const metadata = await manager.getOwnerTokenMetadata("user-dto", { model });

  expect(metadata.oauth).toMatchObject({
    hasAccessToken: true,
    hasRefreshToken: true,
    scope: "identify guilds.join",
    tokenType: "Bearer",
    issuedAt: 5000,
    expiresAt: 50000,
    lastRefreshAt: 10000,
    revokedAt: null
  });
  expect(metadata.oauth.accessToken).toBeUndefined();
  expect(metadata.oauth.refreshToken).toBeUndefined();
  expect(metadata.oauth.encryptedAccessToken).toBeUndefined();
  expect(metadata.oauth.encryptedRefreshToken).toBeUndefined();
});

test("oauthTokenManager: validateTokenData rejects whitespace-only access_token and refresh_token", () => {
  expect(() => manager._test.validateTokenData({
    access_token: "   ",
    refresh_token: "valid-refresh",
    expires_in: 3600
  })).toThrow(/missing or invalid access_token/);

  expect(() => manager._test.validateTokenData({
    access_token: "valid-access",
    refresh_token: "   \t\n  ",
    expires_in: 3600
  })).toThrow(/missing or invalid refresh_token/);

  expect(() => manager._test.validateTokenData({
    access_token: "valid-access",
    refresh_token: "valid-refresh",
    expires_in: 3600,
    token_type: 12345
  })).toThrow(/token_type must be a string/);

  const prepared = manager.prepareStoredToken({
    access_token: "valid-access",
    refresh_token: "valid-refresh",
    expires_in: 3600,
    token_type: "   "
  }, { now: 1000 });
  expect(prepared.tokenType).toBe("Bearer");
});

test("oauthTokenManager: getAccessToken propagates marginMs and deterministic now to refresh check", async () => {
  const encRefresh = encryptToken("refresh-margin");
  const encAccess = encryptToken("access-margin");
  const now = 1000000;
  const expiresAt = now + 30 * 60 * 1000; // 30 minutes remaining
  const doc = {
    _id: "doc-margin",
    discord: { userId: "user-margin" },
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      expiresAt,
      version: 1,
      revokedAt: null
    }
  };

  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(doc)
      })
    })),
    findById: jest.fn(() => freshQuery(() => doc)),
    updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 1 }))
  };

  const discord = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "refreshed-new-access",
      refresh_token: "refreshed-new-refresh",
      expires_in: 3600
    }))
  };

  // Calling with 1 hour margin (60m > 30m, so isDue is true and refresh triggers)
  const res = await manager.getAccessToken({
    userId: "user-margin",
    tokenField: "oauth",
    marginMs: 60 * 60 * 1000,
    now,
    model,
    discord
  });

  expect(res.ok).toBe(true);
  expect(res.refreshed).toBe(true);
  expect(res.accessToken).toBe("refreshed-new-access");
  expect(discord.refreshToken).toHaveBeenCalled();
});

test("oauthTokenManager: refresh wins race before revoke finishes; revoke still leaves final state revoked", async () => {
  const encRefresh = encryptToken("refresh-race-token");
  const encAccess = encryptToken("access-race-token");
  const doc = {
    _id: "doc-race-winner",
    discord: { userId: "user-race-winner" },
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      expiresAt: 50000,
      version: 3,
      revokedAt: null
    }
  };

  let dbVersion = 3;
  let dbRevokedAt = null;

  const model = {
    findOne: jest.fn(() => ({
      select: () => Promise.resolve({
        ...doc,
        oauth: {
          ...doc.oauth,
          version: dbVersion,
          revokedAt: dbRevokedAt
        }
      })
    })),
    updateOne: jest.fn((filter, update) => {
      // Simulate CAS: if filter requires version 3, but concurrent refresh changed it to 4:
      if (filter["oauth.version"] !== undefined && filter["oauth.version"] !== dbVersion) {
        return Promise.resolve({ modifiedCount: 0 });
      }
      if (update.$set && update.$set["oauth.revokedAt"]) {
        dbRevokedAt = update.$set["oauth.revokedAt"];
      }
      if (update.$inc && update.$inc["oauth.version"]) {
        dbVersion += update.$inc["oauth.version"];
      }
      return Promise.resolve({ modifiedCount: 1 });
    })
  };

  const discord = {
    revokeToken: jest.fn(() => {
      // Concurrent refresh finished while Discord revoke endpoint was in flight
      dbVersion = 4;
      return Promise.resolve();
    })
  };

  const outcome = await manager.revokeToken({
    userId: "user-race-winner",
    tokenField: "oauth",
    model,
    discord,
    now: 99999
  });

  expect(outcome.ok).toBe(true);
  expect(outcome.revoked).toBe(true);
  expect(outcome.updated).toBe(true);
  expect(dbRevokedAt).toBe(99999);
  expect(dbVersion).toBeGreaterThanOrEqual(4);
});

test("oauthTokenManager: listAccessTokenCandidates returns nextCursor and hasMore pagination metadata", async () => {
  const encRefresh = encryptToken("valid-refresh");
  const docs = [
    {
      _id: "doc-page-1",
      discord: { userId: "user-page-1" },
      oauth: {
        encryptedRefreshToken: encRefresh,
        scope: "identify guilds.join",
        revokedAt: null,
        refreshFailCount: 0
      }
    },
    {
      _id: "doc-page-2",
      discord: { userId: "user-page-2" },
      oauth: {
        encryptedRefreshToken: encRefresh,
        scope: "identify email", // missing guilds.join
        revokedAt: null,
        refreshFailCount: 0
      }
    }
  ];

  const model = {
    find: jest.fn(() => scanQuery(docs))
  };

  const page = await manager.listAccessTokenCandidates({
    requiredScopes: ["guilds.join"],
    limit: 2,
    model
  });

  expect(Array.isArray(page.candidates)).toBe(true);
  expect(page.length).toBe(1);
  expect(page.nextCursor).toBe("doc-page-2");
  expect(page.hasMore).toBe(true);
  expect(page.scanned).toBe(2);
  expect(page.candidates.length).toBe(1);
  expect(page.statistics.scannedRecords).toBe(2);
  expect(page.statistics.usableUsers).toBe(1);
  expect(page.statistics.missingScope).toBe(1);
  expect(() => JSON.stringify(page)).not.toThrow();
});

test("oauthTokenManager: getOwnerTokenState, getOwnerTokenMetadata, and getRecoveryStatuses exclude soft-deleted users", async () => {
  const encAccess = encryptToken("access-secret");
  const encRefresh = encryptToken("refresh-secret");
  const activeDoc = {
    discord: { userId: "active-user" },
    deletedAt: null,
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      scope: "identify guilds.join",
      expiresAt: Date.now() + 60000
    }
  };

  const model = {
    findOne: jest.fn((filter) => ({
      select: () => ({
        lean: () => {
          if (filter["discord.userId"] === "deleted-user") return Promise.resolve(null);
          return Promise.resolve(activeDoc);
        }
      })
    })),
    find: jest.fn((filter) => ({
      select: () => ({
        lean: () => {
          return Promise.resolve([activeDoc]);
        }
      })
    }))
  };

  const stateActive = await manager.getOwnerTokenState("active-user", { model });
  expect(stateActive.oauth.accessToken).toBe("access-secret");

  const stateDeleted = await manager.getOwnerTokenState("deleted-user", { model });
  expect(stateDeleted.oauth.accessToken).toBeNull();

  const metadataDeleted = await manager.getOwnerTokenMetadata("deleted-user", { model });
  expect(metadataDeleted.oauth.hasAccessToken).toBe(false);

  const recoveryMap = await manager.getRecoveryStatuses(["active-user", "deleted-user"], { model });
  const deletedRecovery = recoveryMap.get("deleted-user");
  expect(deletedRecovery.status).toBe("missing");
  expect(deletedRecovery.reasons).toContain("record_missing");
});

test("oauthTokenManager: getRecoveryStatuses flags refresh_exhausted when refreshFailCount >= failMax", async () => {
  const encAccess = encryptToken("valid-access");
  const encRefresh = encryptToken("valid-refresh");
  const doc = {
    discord: { userId: "user-exhausted" },
    oauth: {
      encryptedAccessToken: encAccess,
      encryptedRefreshToken: encRefresh,
      scope: "identify email connections guilds guilds.members.read guilds.join",
      expiresAt: Date.now() + 60000,
      refreshFailCount: 5,
      revokedAt: null
    }
  };

  const model = {
    find: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve([doc])
      })
    }))
  };

  const recoveryMap = await manager.getRecoveryStatuses(["user-exhausted"], {
    model,
    failMax: 5
  });

  const recovery = recoveryMap.get("user-exhausted");
  expect(recovery.reasons).toContain("refresh_exhausted");
  expect(recovery.reasonLabels).toContain("Refresh ล้มเหลวถึงจำนวนสูงสุด");
});

test("joinCampaign: processAllCandidateBatches continues across batches even when first batch yields zero candidates", async () => {
  const batch1 = [
    {
      _id: "batch1-doc1",
      discord: { userId: "b1-u1" },
      oauth: { scope: "identify email" }
    }
  ];
  Object.assign(batch1, {
    candidates: [],
    nextCursor: "batch1-doc1",
    hasMore: true,
    scanned: 1
  });

  const batch2 = [
    {
      _id: "batch2-doc1",
      recordId: "batch2-doc1",
      userId: "b2-u1",
      tokenField: "oauth",
      scope: "identify guilds.join"
    }
  ];
  Object.assign(batch2, {
    candidates: batch2,
    nextCursor: "batch2-doc1",
    hasMore: false,
    scanned: 1
  });

  const loadCandidateDocs = jest.fn(async ({ afterId }) => {
    if (!afterId) return batch1;
    if (afterId === "batch1-doc1") return batch2;
    return [];
  });

  const processed = [];
  const fakeTokenManager = {
    getAccessToken: async ({ userId }) => {
      processed.push(userId);
      return { ok: true, accessToken: "token-" + userId, refreshed: false };
    }
  };

  const summary = {
    campaignId: "test-pag",
    status: "running",
    scannedRecords: 0,
    uniqueUsers: 0,
    usableUsers: 0,
    missingScope: 0,
    missingUserId: 0,
    byTokenField: { oauth: 0, adminOAuth: 0 },
    joined: 0,
    alreadyMember: 0,
    failed: 0,
    refreshed: 0,
    refreshFailed: 0,
    persistenceFailed: 0,
    refreshStateConflicts: 0,
    tokenInvalid: 0,
    botMissingPermission: 0,
    rateLimited: 0,
    discordError: 0,
    stopped: false,
    batches: 0,
    dryRun: false
  };

  const context = {
    config: { batchSize: 1, delayMs: 0, progressEvery: 10 },
    targetGuildId: "123456789012345678",
    discord: {
      getGuildMemberWithBot: async () => null,
      addMemberToGuild: async () => ({ ok: true, status: 201 })
    }
  };

  const joinCampaign = require("../discord/features/joinCampaign");
  await joinCampaign._test.processAllCandidateBatches(summary, context, {
    loadCandidateDocs,
    oauthTokenManager: fakeTokenManager
  });

  expect(loadCandidateDocs).toHaveBeenCalledTimes(2);
  expect(processed).toEqual(["b2-u1"]);
  expect(summary.joined).toBe(1);
});

test("oauthTokenManager: getAccessToken halts early with oauth_refresh_exhausted when refreshFailCount >= failMax", async () => {
  const encRefresh = encryptToken("refresh-secret");
  const doc = {
    discord: { userId: "user-exhausted-get" },
    oauth: {
      encryptedRefreshToken: encRefresh,
      expiresAt: 1000,
      refreshFailCount: 5,
      revokedAt: null
    }
  };
  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(doc)
      })
    }))
  };
  const discord = {
    refreshToken: jest.fn()
  };

  const outcome = await manager.getAccessToken({
    userId: "user-exhausted-get",
    tokenField: "oauth",
    model,
    discord,
    now: 50000
  });

  expect(outcome.ok).toBe(false);
  expect(outcome.code).toBe("oauth_refresh_exhausted");
  expect(discord.refreshToken).not.toHaveBeenCalled();
});

test("oauthTokenManager: commitVerificationActivation serializes under token state mutation lock with revokeToken", async () => {
  const userId = "u-lock-concurrency";
  let activeVersion = 2;
  const executionOrder = [];

  const model = {
    findOne: jest.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve({
          discord: { userId },
          oauth: {
            encryptedAccessToken: encryptToken("old-access"),
            encryptedRefreshToken: encryptToken("old-refresh"),
            version: activeVersion,
            revokedAt: null
          }
        })
      })
    })),
    findOneAndUpdate: jest.fn(async (filter, update) => {
      executionOrder.push("activation_write");
      activeVersion = update.$set.oauth.version;
      return { _id: "doc-concurrency", ...update.$set };
    }),
    updateOne: jest.fn(async (filter, update) => {
      executionOrder.push("revoke_write");
      if (update.$inc && update.$inc["oauth.version"]) {
        activeVersion += update.$inc["oauth.version"];
      }
      return { modifiedCount: 1 };
    })
  };

  const discord = {
    revokeToken: jest.fn(async () => {
      executionOrder.push("discord_revoke");
    })
  };

  const pActivation = manager.commitVerificationActivation({
    profileUserId: userId,
    tokenData: {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 3600
    },
    updateSet: {},
    model,
    now: 100000
  });

  const pRevoke = manager.revokeToken({
    userId,
    tokenField: "oauth",
    model,
    discord,
    now: 100001
  });

  const [resActivation, resRevoke] = await Promise.all([pActivation, pRevoke]);

  expect(resActivation.ok).toBe(true);
  expect(resRevoke.ok).toBe(true);
  expect(executionOrder.indexOf("activation_write")).toBeLessThan(executionOrder.indexOf("revoke_write"));
  expect(activeVersion).toBeGreaterThan(2);
});

test("joinCampaign: processAllCandidateBatches merges true page.statistics into summary", async () => {
  const page = {
    candidates: [
      {
        recordId: "p1-doc1",
        userId: "u-stat-1",
        tokenField: "oauth",
        scope: "identify guilds.join"
      }
    ],
    nextCursor: "p1-doc500",
    hasMore: false,
    scanned: 500,
    statistics: {
      scannedRecords: 500,
      uniqueUsers: 480,
      usableUsers: 1,
      missingScope: 470,
      missingUserId: 9,
      revoked: 0,
      exhausted: 0,
      byTokenField: { oauth: 1, adminOAuth: 0 }
    }
  };

  const loadCandidateDocs = jest.fn(async () => page);

  const summary = {
    campaignId: "test-stats",
    status: "running",
    scannedRecords: 0,
    uniqueUsers: 0,
    usableUsers: 0,
    missingScope: 0,
    missingUserId: 0,
    byTokenField: { oauth: 0, adminOAuth: 0 },
    joined: 0,
    alreadyMember: 0,
    failed: 0,
    refreshed: 0,
    refreshFailed: 0,
    persistenceFailed: 0,
    refreshStateConflicts: 0,
    tokenInvalid: 0,
    botMissingPermission: 0,
    rateLimited: 0,
    discordError: 0,
    stopped: false,
    batches: 0,
    dryRun: false
  };

  const context = {
    config: { batchSize: 500, delayMs: 0, progressEvery: 10 },
    targetGuildId: "123456789012345678",
    discord: {
      getGuildMemberWithBot: async () => null,
      addMemberToGuild: async () => ({ ok: true, status: 201 })
    }
  };

  const fakeTokenManager = {
    getAccessToken: async ({ userId }) => ({ ok: true, accessToken: "token-" + userId, refreshed: false })
  };

  const joinCampaign = require("../discord/features/joinCampaign");
  await joinCampaign._test.processAllCandidateBatches(summary, context, {
    loadCandidateDocs,
    oauthTokenManager: fakeTokenManager
  });

  expect(summary.scannedRecords).toBe(500);
  expect(summary.uniqueUsers).toBe(480);
  expect(summary.usableUsers).toBe(1);
  expect(summary.missingScope).toBe(470);
  expect(summary.missingUserId).toBe(9);
  expect(summary.joined).toBe(1);
});
