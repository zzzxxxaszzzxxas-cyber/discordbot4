"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const modeRegistry = require("../features/joinCampaign/modes/modeRegistry");
const { buildBaseSetupModal, buildStartOptionsModal, CUSTOM_IDS } = require("../features/joinCampaign/ui/modals");
const { buildPanelPayload, IDS: PANEL_IDS } = require("../features/joinCampaign/ui/panelBuilder");
const { buildPreflightConfirmationPayload, IDS: CONFIRM_IDS } = require("../features/joinCampaign/ui/confirmationBuilder");
const joinCampaignService = require("../features/joinCampaign/services/joinCampaignService");
const { isJoinCampaignInteraction, handleJoinCampaignInteraction } = require("../features/joinCampaign/handlers/interactionRouter");
const { handleJoinPanelCommand } = require("../features/joinCampaign/handlers/commandHandler");
const { isValidDiscordWebhookUrl, sanitizeUserFacingError } = require("../features/joinCampaign/worker/batchLogger");
const { runPreflight, validateGuildTargets } = require("../features/joinCampaign/services/preflightService");
const { streamCandidates } = require("../features/joinCampaign/services/candidateQueryService");
const campaignWorker = require("../features/joinCampaign/worker/campaignWorker");
const { runStartupRecovery } = require("../features/joinCampaign/recovery/startupRecovery");
const discordApi = require("../verification/utils/discordAPI");
const database = require("../../database/index");

test.beforeEach(() => {
    try {
        const repo = database.repositories.joinCampaign;
        repo.db.prepare("DELETE FROM join_campaign_jobs").run();
        repo.db.prepare("DELETE FROM join_campaign_items").run();
    } catch (_) {}
});

test.after(() => {
    try {
        const repo = database.repositories.joinCampaign;
        repo.db.prepare("DELETE FROM join_campaign_jobs").run();
        repo.db.prepare("DELETE FROM join_campaign_items").run();
    } catch (_) {}
});

test("Join Campaign: Mode registry lists modes and retrieves by id", () => {
    const modes = modeRegistry.listModes();
    assert.ok(modes.length >= 2);
    
    const allMode = modeRegistry.getMode("ALL_TO_TARGET");
    assert.equal(allMode.id, "ALL_TO_TARGET");
    assert.equal(allMode.requiresSource, false);

    const g2gMode = modeRegistry.getMode("GUILD_TO_GUILD");
    assert.equal(g2gMode.id, "GUILD_TO_GUILD");
    assert.equal(g2gMode.requiresSource, true);

    const fallback = modeRegistry.getMode("NON_EXISTENT_MODE");
    assert.equal(fallback.id, "ALL_TO_TARGET");
});

test("Join Campaign: Modals generate valid Discord Components", () => {
    const allMode = modeRegistry.getMode("ALL_TO_TARGET");
    const setupModalAll = buildBaseSetupModal({ mode: allMode, currentState: { targetGuildId: "123456789012345678" } });
    assert.ok(setupModalAll.data.custom_id.startsWith(CUSTOM_IDS.MODAL_SETUP_PREFIX));
    assert.equal(setupModalAll.components.length, 1); // Only target guild input

    const g2gMode = modeRegistry.getMode("GUILD_TO_GUILD");
    const setupModalG2G = buildBaseSetupModal({ mode: g2gMode, currentState: {} });
    assert.equal(setupModalG2G.components.length, 2); // Target and source guild inputs

    const startModal = buildStartOptionsModal();
    assert.equal(startModal.data.custom_id, CUSTOM_IDS.MODAL_START);
    assert.equal(startModal.components.length, 2); // requested_amount and webhook_url
});

test("Join Campaign: Panel builder constructs embed and rows reflecting state", () => {
    const allMode = modeRegistry.getMode("ALL_TO_TARGET");
    const payloadIdle = buildPanelPayload({
        mode: allMode,
        panelState: {
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678"
        },
        readyCount: 120,
        targetGuildName: "Target Server"
    });
    assert.ok(payloadIdle.embeds.length === 1);
    assert.ok(payloadIdle.components.length === 2);
    
    // Start button is enabled when idle
    const buttonRow = payloadIdle.components[1];
    assert.equal(buttonRow.components[0].data.disabled, false);

    const payloadRunning = buildPanelPayload({
        mode: allMode,
        panelState: {
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678"
        },
        liveJob: {
            status: "RUNNING",
            joinedCount: 15,
            requestedAmount: 50
        },
        targetGuildName: "Target Server"
    });
    // Start button is disabled when running
    const runningButtonRow = payloadRunning.components[1];
    assert.equal(runningButtonRow.components[0].data.disabled, true);
    assert.match(payloadRunning.embeds[0].data.fields.find(f => f.name.includes("สถานะ")).value, /กำลังดึงสมาชิก/);
});

test("Join Campaign: Confirmation builder formats ephemeral confirmation with single confirm button", () => {
    const payload = buildPreflightConfirmationPayload({
        stageId: "stage_test_123",
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        targetGuildId: "123456789012345678",
        targetGuildName: "Target Guild",
        readyCount: 85,
        requestedQuota: 50,
        hasWebhook: false
    });

    assert.ok(payload.embeds.length === 1);
    assert.ok(payload.components.length === 1);
    const confirmButton = payload.components[0].components[0];
    assert.equal(confirmButton.data.custom_id, `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}stage_test_123`);
    assert.match(confirmButton.data.label, /ยืนยัน/);
});

test("Join Campaign: isJoinCampaignInteraction detects subsystem IDs", () => {
    assert.equal(isJoinCampaignInteraction({ customId: PANEL_IDS.SELECT_MODE }), true);
    assert.equal(isJoinCampaignInteraction({ customId: PANEL_IDS.BTN_START }), true);
    assert.equal(isJoinCampaignInteraction({ customId: `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}abc` }), true);
    assert.equal(isJoinCampaignInteraction({ customId: `${CUSTOM_IDS.MODAL_SETUP_PREFIX}ALL_TO_TARGET` }), true);
    assert.equal(isJoinCampaignInteraction({ customId: CUSTOM_IDS.MODAL_START }), true);
    assert.equal(isJoinCampaignInteraction({ customId: "unrelated_button" }), false);
});

test("Join Campaign: SQLite Repository persists panel and jobs", async () => {
    const repo = database.repositories.joinCampaign;
    assert.ok(repo, "JoinCampaignRepository must be available on database singleton");

    const channelId = `test_ch_${Date.now()}`;
    const panel = repo.savePanelState({
        channelId,
        guildId: "111111111111111111",
        messageId: "222222222222222222",
        mode: "ALL_TO_TARGET",
        targetGuildId: "333333333333333333",
        targetGuildName: "Test Target",
        readyCount: 42
    });
    assert.ok(panel);

    const found = repo.findPanelByChannelId(channelId);
    assert.equal(found.channelId, channelId);
    assert.equal(found.targetGuildId, "333333333333333333");
    assert.equal(found.readyCount, 42);

    // Job Lifecycle in SQLite
    const testJobId = `job_${Date.now()}`;
    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "333333333333333333",
        targetGuildName: "Test Target",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 42,
        joinedCount: 0,
        alreadyCount: 0,
        failedCount: 0
    });
    assert.equal(job.id, testJobId);
    assert.equal(job.status, "RUNNING");

    const active = repo.getActiveJob();
    assert.ok(active);
    assert.equal(active.id, testJobId);

    // Update Progress
    repo.updateJobProgress(testJobId, {
        joinedCount: 5,
        alreadyCount: 1,
        failedCount: 0
    });
    const updated = repo.findJobById(testJobId);
    assert.equal(updated.joinedCount, 5);

    // Complete Job
    repo.markJobCompleted(testJobId);
    const completed = repo.findJobById(testJobId);
    assert.equal(completed.status, "COMPLETED");
    assert.ok(completed.completedAt);

    // Active job should now be null
    assert.equal(repo.getActiveJob(), null);
});

test("Join Campaign: isValidDiscordWebhookUrl strictly validates Discord webhook patterns", () => {
    assert.equal(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123456789012345678/abcdef-ghijklmn"), true);
    assert.equal(isValidDiscordWebhookUrl("https://discordapp.com/api/webhooks/123456789012345678/abcdef_ghijklmn-123"), true);
    assert.equal(isValidDiscordWebhookUrl("https://canary.discord.com/api/webhooks/123456789012345678/abc-def"), true);
    assert.equal(isValidDiscordWebhookUrl("https://ptb.discord.com/api/webhooks/123456789012345678/abc-def"), true);
    
    // SSRF & Arbitrary URL Rejections
    assert.equal(isValidDiscordWebhookUrl("http://discord.com/api/webhooks/123/abc"), false); // Insecure HTTP
    assert.equal(isValidDiscordWebhookUrl("https://evil.com/api/webhooks/123/abc"), false); // Non-discord host
    assert.equal(isValidDiscordWebhookUrl("https://127.0.0.1/api/webhooks/123/abc"), false); // Localhost IP
    assert.equal(isValidDiscordWebhookUrl("https://169.254.169.254/api/webhooks/123/abc"), false); // Cloud metadata IP
    assert.equal(isValidDiscordWebhookUrl("https://discord.com.attacker.com/api/webhooks/123/abc"), false); // Spoofed domain
    assert.equal(isValidDiscordWebhookUrl(""), false);
    assert.equal(isValidDiscordWebhookUrl(null), false);
});

test("Join Campaign: Preflight sets requestedQuota accurately without clamping to readyCount", async () => {
    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    memberCount: 5,
                    members: {
                        cache: new Map([["bot_id", { id: "bot_id" }]]),
                        fetch: async () => new Map([["user_already_in", { id: "user_already_in" }]]),
                        me: {
                            permissions: {
                                has: () => true
                            }
                        }
                    }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "user_1" } },
            { discord: { userId: "user_2" } }
        ]
    };

    // When requestedAmount is 100 and readyCount is 2: requestedQuota must be 100 (NOT clamped to 2)
    const preflight = await runPreflight({
        client: mockClient,
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: 100,
        tokenManager: mockTokenManager,
        config: { enabled: true, allowedGuilds: new Set() }
    });

    assert.equal(preflight.ok, true);
    assert.equal(preflight.readyCount, 2);
    assert.equal(preflight.requestedQuota, 100);

    // When requestedAmount is not provided, defaults to readyCount
    const preflightDefault = await runPreflight({
        client: mockClient,
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: null,
        tokenManager: mockTokenManager,
        config: { enabled: true, allowedGuilds: new Set() }
    });

    assert.equal(preflightDefault.ok, true);
    assert.equal(preflightDefault.requestedQuota, 2);
});

test("Join Campaign: Startup recovery increments recovery_count and releases expired leases", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `rec_job_${Date.now()}`;
    
    // Create an interrupted job
    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Recovery Target",
        status: "RUNNING",
        requestedAmount: 50,
        selectedAmount: 50,
        joinedCount: 10,
        recoveryCount: 0
    });

    // Enqueue an item and lease it
    repo.createItems(testJobId, [{ userId: "cand_leased", tokenField: "oauth" }]);
    const item = repo.claimNextPendingItem(testJobId, 30000);
    assert.ok(item);
    assert.equal(item.status, "processing");

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Recovery Target",
                    memberCount: 1,
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({ candidates: [], hasMore: false }),
        getAccessToken: async () => null
    };

    const recoveryResult = await runStartupRecovery({
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager
    });

    assert.equal(recoveryResult.recovered, true);
    assert.equal(recoveryResult.jobId, testJobId);

    // Check that recovery_count was incremented in DB
    const updatedJob = repo.findJobById(testJobId);
    assert.equal(updatedJob.recoveryCount, 1);

    // Wait for resumed worker to complete and clean up job
    await campaignWorker.waitForCompletion();
    repo.markJobCompleted(testJobId);
});

test("Join Campaign: Adaptive worker halts immediately on Discord Guild Full error 30005", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `guild_full_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Full Guild",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 10,
        joinedCount: 0
    });

    // Mock candidates
    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "user_full_1" }, tokenField: "oauth" }
        ],
        getAccessToken: async () => ({ accessToken: "mock_token" })
    };

    // Discord API returns error 30005 (Maximum number of guild members reached)
    const mockDiscordApi = {
        addMemberToGuild: async () => ({
            ok: false,
            status: 400,
            error: {
                code: 30005,
                message: "Maximum number of guild members reached (250000)"
            }
        })
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Full Guild"
                }]
            ])
        }
    };

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: mockDiscordApi,
        targetMemberIds: new Set()
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.status, "SERVER_FULL");
    assert.match(finishedJob.lastError, /เซิร์ฟเวอร์ปลายทางมีสมาชิกเต็มแล้ว/);
});

test("Join Campaign: Adaptive worker skips members already in target guild without calling API", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `skip_test_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Skip Target",
        status: "RUNNING",
        requestedAmount: 1,
        selectedAmount: 2,
        joinedCount: 0
    });

    let apiCalls = 0;
    const mockDiscordApi = {
        addMemberToGuild: async () => {
            apiCalls++;
            return { ok: true, status: 201 };
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "already_here_user" }, tokenField: "oauth" },
            { discord: { userId: "new_user" }, tokenField: "oauth" }
        ],
        getAccessToken: async () => ({ accessToken: "mock_token" })
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Skip Target"
                }]
            ])
        }
    };

    // Pre-seed targetMemberIds with already_here_user
    const targetMemberIds = new Set(["already_here_user"]);

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: mockDiscordApi,
        targetMemberIds
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.joinedCount, 1);
    assert.equal(finishedJob.alreadyCount, 1);
    // Only new_user should have called addMemberToGuild
    assert.equal(apiCalls, 1);
});

test("Join Campaign: Quota overshoot protection - Quota=1 with concurrency=8 strictly joins at most 1 member", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `overshoot_test_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        targetGuildName: "Quota Target",
        status: "RUNNING",
        requestedAmount: 1, // Only 1 wanted
        selectedAmount: 8,
        joinedCount: 0,
        currentConcurrency: 8
    });

    let joinCalls = 0;
    const mockDiscordApi = {
        addMemberToGuild: async () => {
            joinCalls++;
            // Small artificial latency to simulate real network request
            await new Promise(r => setTimeout(r, 20));
            return { ok: true, status: 201 };
        }
    };

    // 8 candidates available
    const candidates = [];
    for (let i = 1; i <= 8; i++) {
        candidates.push({ discord: { userId: `user_overshoot_${i}` }, tokenField: "oauth" });
    }

    const mockTokenManager = {
        listAccessTokenCandidates: async () => candidates,
        getAccessToken: async () => ({ accessToken: "mock_token" })
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", { id: "123456789012345678", name: "Quota Target" }]
            ])
        }
    };

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: mockDiscordApi,
        targetMemberIds: new Set()
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    // Quota overshoot MUST NOT occur: joinedCount must be exactly 1!
    assert.equal(finishedJob.joinedCount, 1);
    assert.equal(finishedJob.status, "COMPLETED");
});

test("Join Campaign: claimNextPendingItem respects retry delay leased_until", () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `retry_delay_${Date.now()}`;

    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5,
        joinedCount: 0
    });

    // Create a candidate item
    repo.createItems(testJobId, [{ userId: "retry_delayed_user", tokenField: "oauth" }]);

    // Schedule retry with delay of 10 seconds into the future
    repo.incrementItemAttempt(testJobId, "retry_delayed_user", "rate_limited", 10000);

    // Attempt to claim: should return null because leased_until > now
    const claimedBeforeDelay = repo.claimNextPendingItem(testJobId);
    assert.equal(claimedBeforeDelay, null);

    // Create a new normal pending item
    repo.createItems(testJobId, [{ userId: "fresh_pending_user", tokenField: "oauth" }]);

    // Claim: should claim the fresh user, NOT the delayed user
    const claimedFresh = repo.claimNextPendingItem(testJobId);
    assert.ok(claimedFresh);
    assert.equal(claimedFresh.userId, "fresh_pending_user");
});

test("Join Campaign: Atomic single active campaign lock in SQLite prevents two concurrent RUNNING/STAGE jobs", () => {
    const repo = database.repositories.joinCampaign;
    const jobId1 = `atomic_1_${Date.now()}`;
    const jobId2 = `atomic_2_${Date.now()}`;

    const job1 = repo.createJob({
        id: jobId1,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 10,
        joinedCount: 0
    });
    assert.ok(job1);

    // Attempting to create a second RUNNING job must fail atomically
    assert.throws(() => {
        repo.createJob({
            id: jobId2,
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678",
            status: "RUNNING",
            requestedAmount: 5,
            selectedAmount: 5,
            joinedCount: 0
        });
    }, (err) => {
        return err.code === "ACTIVE_CAMPAIGN_EXISTS" || String(err.message).includes("UNIQUE constraint failed");
    });

    // Mark job1 as COMPLETED
    repo.markJobCompleted(jobId1);

    // Now creating another active job succeeds
    const job2 = repo.createJob({
        id: jobId2,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5,
        joinedCount: 0
    });
    assert.ok(job2);
    repo.markJobCompleted(jobId2);
});

test("Join Campaign: Worker fails closed and does not fallback to cache when target member fetch fails", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `fail_closed_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5,
        joinedCount: 0
    });

    // Mock client where member fetch throws error
    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    memberCount: 50,
                    members: {
                        fetch: async () => { throw new Error("Discord API 500: Internal Server Error"); },
                        cache: new Map([["cached_user_1", {}]]) // Partial cache
                    }
                }]
            ])
        }
    };

    // startWorker must reject and fail-closed without using partial cache
    await assert.rejects(async () => {
        await campaignWorker.startWorker({
            job,
            client: mockClient,
            repository: repo,
            targetMemberIds: null // Force live query
        });
        await campaignWorker.waitForCompletion();
    }, (err) => {
        return String(err.message).includes("Fail-Closed");
    });

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.status, "FAILED");
    assert.match(finishedJob.lastError, /Fail-Closed/);
});

test("Join Campaign: Candidate pagination continues to next batch when page has 0 usable candidates but hasMore is true", async () => {
    let callCount = 0;
    const mockTokenManager = {
        listAccessTokenCandidates: async ({ afterId }) => {
            callCount++;
            if (callCount === 1) {
                // Batch 1: returns empty array of candidates, but hasMore is true!
                return { candidates: [], nextCursor: "cursor_batch_2", hasMore: true };
            }
            if (callCount === 2) {
                // Batch 2: returns actual candidate!
                return {
                    candidates: [{ discord: { userId: "user_from_page_2" }, _id: "doc_page_2" }],
                    nextCursor: "cursor_batch_3",
                    hasMore: false
                };
            }
            return { candidates: [], hasMore: false };
        }
    };

    const dummyMode = { requiresSource: false };
    const generator = streamCandidates({
        mode: dummyMode,
        tokenManager: mockTokenManager,
        batchSize: 10
    });

    const collected = [];
    for await (const item of generator) {
        collected.push(item);
    }

    assert.equal(callCount, 2);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].candidate.discord.userId, "user_from_page_2");
});

test("Join Campaign: Candidate exhaustion with 0 joined results in FAILED status, not COMPLETED", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `zero_joined_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 1,
        joinedCount: 0
    });

    // 1 candidate whose token retrieval fails
    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "user_fail_token" }, tokenField: "oauth" }
        ],
        getAccessToken: async () => null // Token missing/failed
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", { id: "123456789012345678", name: "Target" }]
            ])
        }
    };

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: { addMemberToGuild: async () => ({ ok: false }) },
        targetMemberIds: new Set()
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.joinedCount, 0);
    // When 0 joined and candidate pool is exhausted: must be FAILED, NOT COMPLETED!
    assert.equal(finishedJob.status, "FAILED");
});

test("Join Campaign: processedCount counts unique users on first attempt, retryCount counts retries", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = `metrics_test_${Date.now()}`;

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 1,
        selectedAmount: 1,
        joinedCount: 0
    });

    let attemptNumber = 0;
    const mockDiscordApi = {
        addMemberToGuild: async () => {
            attemptNumber++;
            if (attemptNumber === 1) {
                // Return 429 on first try with 20ms retryAfter
                return { ok: false, status: 429, retryAfter: 20 };
            }
            return { ok: true, status: 201 };
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => [
            { discord: { userId: "user_metrics_1" }, tokenField: "oauth" }
        ],
        getAccessToken: async () => ({ accessToken: "mock_token" })
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", { id: "123456789012345678", name: "Target" }]
            ])
        }
    };

    await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        discord: mockDiscordApi,
        targetMemberIds: new Set()
    });

    await campaignWorker.waitForCompletion();

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.joinedCount, 1);
    // processedCount must count the 1 unique user, not 2 attempts
    assert.equal(finishedJob.processedCount, 1);
    // retryCount must record the retry attempt
    assert.equal(finishedJob.retryCount, 1);
});

test("Join Campaign: sanitizeUserFacingError converts technical/database errors to polite human Thai", () => {
    const sqliteErr = sanitizeUserFacingError("SQLITE_BUSY: database is locked");
    assert.match(sqliteErr, /ฐานข้อมูลกำลังประมวลผลงานอื่นอยู่ชั่วคราว/);

    const mongoErr = sanitizeUserFacingError("MongoServerSelectionError: connection timed out");
    assert.match(mongoErr, /การเชื่อมต่อฐานข้อมูลหลักขัดข้องชั่วคราว/);

    const abortErr = sanitizeUserFacingError("AbortError: operation was aborted");
    assert.match(abortErr, /การเชื่อมต่อไปยัง Discord เกิดความล่าช้า/);

    const failClosedErr = sanitizeUserFacingError("ไม่สามารถตรวจสอบรายชื่อสมาชิกในเซิร์ฟเวอร์เป้าหมายได้ครบถ้วน (Fail-Closed)");
    assert.match(failClosedErr, /ไม่สามารถตรวจสอบรายชื่อสมาชิก/);

    const cleanMsg = sanitizeUserFacingError("เซิร์ฟเวอร์ปลายทางมีสมาชิกถึงจำนวนสูงสุดแล้ว");
    assert.equal(cleanMsg, "เซิร์ฟเวอร์ปลายทางมีสมาชิกถึงจำนวนสูงสุดแล้ว");
});

test("Join Campaign: discordApi.addMemberToGuild accepts callerManagedRetry option and handles validation", async () => {
    // Missing credentials fails fast with status 400 without looping
    const resMissing = await discordApi.addMemberToGuild(null, "123", "token", { callerManagedRetry: true });
    assert.equal(resMissing.ok, false);
    assert.equal(resMissing.status, 400);
    assert.equal(resMissing.error, "Missing guildId/userId/accessToken");
});

test("Join Campaign: Master switch JOIN_CAMPAIGN_ENABLED=false blocks command, interaction, and service layers", async () => {
    const prevEnabled = process.env.JOIN_CAMPAIGN_ENABLED;
    const prevOwner = process.env.OWNER_ID;
    process.env.JOIN_CAMPAIGN_ENABLED = "false";
    process.env.OWNER_ID = "test-owner";

    try {
        let commandReply = null;
        const mockCommandInteraction = {
            guild: { id: "guild-1" },
            user: { id: "test-owner" },
            reply: async (payload) => { commandReply = payload; }
        };
        await handleJoinPanelCommand(mockCommandInteraction, {});
        assert.ok(commandReply?.content?.includes("JOIN_CAMPAIGN_ENABLED=false"));

        let interactionReply = null;
        const mockButtonInteraction = {
            customId: PANEL_IDS.BTN_START,
            user: { id: "test-owner" },
            reply: async (payload) => { interactionReply = payload; }
        };
        await handleJoinCampaignInteraction(mockButtonInteraction, {});
        assert.ok(interactionReply?.content?.includes("JOIN_CAMPAIGN_ENABLED=false"));

        const stageRes = await joinCampaignService.stageCampaign({
            mode: "ALL_TO_TARGET",
            targetGuildId: "123",
            requestedAmount: 10
        });
        assert.equal(stageRes.ok, false);
        assert.match(stageRes.error, /ปิดใช้งาน/);

        const startRes = await joinCampaignService.confirmAndStartCampaign({
            jobId: "some_job",
            guildId: "123"
        });
        assert.equal(startRes.ok, false);
        assert.match(startRes.error, /ปิดใช้งาน/);
    } finally {
        if (prevEnabled !== undefined) {
            process.env.JOIN_CAMPAIGN_ENABLED = prevEnabled;
        } else {
            delete process.env.JOIN_CAMPAIGN_ENABLED;
        }
        if (prevOwner !== undefined) {
            process.env.OWNER_ID = prevOwner;
        } else {
            delete process.env.OWNER_ID;
        }
    }
});

test("Join Campaign: Worker fetches target guild on cache miss and fails closed if guild cannot be resolved", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "worker_missing_guild_" + Date.now();
    const job = repo.createJob({
        id: testJobId,
        guildId: "123456789012345678",
        channelId: "channel_1",
        mode: "ALL_TO_TARGET",
        sourceGuildId: null,
        targetGuildId: "999999999999999999",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5,
        joinedCount: 0
    });

    const mockClient = {
        guilds: {
            cache: new Map(),
            fetch: async (id) => {
                if (id === "999999999999999999") return null;
                throw new Error("Guild not found");
            }
        }
    };

    await assert.rejects(async () => {
        await campaignWorker.startWorker({
            job,
            client: mockClient,
            repository: repo,
            targetMemberIds: null
        });
        await campaignWorker.waitForCompletion();
    }, (err) => {
        return String(err.message).includes("ไม่พบเซิร์ฟเวอร์ปลายทาง");
    });

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.status, "FAILED");
    assert.match(finishedJob.lastError, /ไม่พบเซิร์ฟเวอร์ปลายทาง/);
});

test("Join Campaign: Adaptive worker caps 429 rate limit retries and marks item failed", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "worker_429_cap_" + Date.now();
    const job = repo.createJob({
        id: testJobId,
        guildId: "123456789012345678",
        channelId: "channel_1",
        mode: "ALL_TO_TARGET",
        sourceGuildId: null,
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 1,
        selectedAmount: 1,
        joinedCount: 0
    });

    repo.createItems(testJobId, [
        { userId: "rate_limited_user", tokenField: "oauth" }
    ]);

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    memberCount: 1,
                    members: {
                        fetch: async () => new Map(),
                        cache: new Map()
                    }
                }]
            ])
        }
    };

    const originalAddMember = discordApi.addMemberToGuild;
    let callCount = 0;
    discordApi.addMemberToGuild = async () => {
        callCount++;
        return {
            ok: false,
            status: 429,
            error: "You are being rate limited.",
            retryAfter: 0.05
        };
    };

    try {
        await campaignWorker.startWorker({
            job,
            client: mockClient,
            repository: repo,
            targetMemberIds: new Set(),
            concurrency: 1,
            delayMs: 10,
            tokenManager: {
                getAccessToken: async () => ({ ok: true, accessToken: "mock_tok" }),
                listAccessTokenCandidates: async () => ({ candidates: [], hasMore: false })
            }
        });
        await campaignWorker.waitForCompletion();
    } finally {
        discordApi.addMemberToGuild = originalAddMember;
    }

    const finishedJob = repo.findJobById(testJobId);
    assert.equal(finishedJob.status, "FAILED");
    assert.equal(finishedJob.joinedCount, 0);
    assert.ok(callCount <= 4);
    assert.ok(finishedJob.retryCount > 0);
    const item = repo.db.prepare("SELECT * FROM join_campaign_items WHERE campaign_id = ?").get(testJobId);
    assert.equal(item.status, "failed");
    assert.equal(item.last_error, "rate_limit_retries_exceeded");
});

test("Join Campaign: Startup recovery fails closed and marks job FAILED when worker start fails", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "rec_fail_job_" + Date.now();
    repo.createJob({
        id: testJobId,
        guildId: "123456789012345678",
        channelId: "channel_1",
        mode: "ALL_TO_TARGET",
        sourceGuildId: null,
        targetGuildId: "invalid_guild_recovery",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 10,
        joinedCount: 0
    });

    const mockClient = {
        guilds: {
            cache: new Map(),
            fetch: async () => { throw new Error("Network offline during recovery"); }
        }
    };

    const recoveryResult = await runStartupRecovery({
        client: mockClient,
        repository: repo
    });
    assert.equal(recoveryResult.recovered, false);
    assert.ok(recoveryResult.error);

    const failedJob = repo.findJobById(testJobId);
    assert.equal(failedJob.status, "FAILED");
    assert.ok(failedJob.completedAt > 0);
    assert.match(failedJob.lastError, /ไม่พบเซิร์ฟเวอร์ปลายทาง|Network offline during recovery/);
});

test("Join Campaign: Preflight strictly validates requested amount and bot member permissions", async () => {
    const prevEnabled = process.env.JOIN_CAMPAIGN_ENABLED;
    process.env.JOIN_CAMPAIGN_ENABLED = "true";
    try {
        const targetGuild = {
            id: "123456789012345678",
            name: "Target Server",
            members: {
                me: {
                    permissions: {
                        has: () => true
                    }
                },
                fetchMe: async () => ({
                    permissions: {
                        has: () => true
                    }
                }),
                list: async () => new Map()
            }
        };
        const mockClient = {
            user: { id: "bot_123" },
            guilds: {
                cache: new Map([["123456789012345678", targetGuild]])
            }
        };

        const mockTokenManager = {
            listAccessTokenCandidates: async () => ({
                candidates: [{ userId: "eligible_user_1", tokenField: "oauth" }],
                hasMore: false
            })
        };

        // Missing permissions in target guild fails validation
        const validateMissingPermsRes = await validateGuildTargets({
            mode: { requiresSource: false },
            client: {
                user: { id: "bot_123" },
                guilds: {
                    cache: new Map([["123456789012345678", {
                        id: "123456789012345678",
                        name: "Target Server",
                        members: { me: null, fetchMe: async () => null }
                    }]])
                }
            },
            baseConfig: { targetGuildId: "123456789012345678" }
        });
        assert.equal(validateMissingPermsRes.ok, false);
        assert.match(validateMissingPermsRes.error, /ไม่สามารถตรวจสอบสิทธิ์ของบอท/);

        // Requested amount 0 rejected
        const runResZero = await runPreflight({
            mode: { requiresSource: false },
            client: mockClient,
            baseConfig: { targetGuildId: "123456789012345678" },
            tokenManager: mockTokenManager,
            requestedAmount: "0"
        });
        assert.equal(runResZero.ok, false);
        assert.match(runResZero.error, /มากกว่า 0/);

        // Negative requested amount rejected
        const runResNegative = await runPreflight({
            mode: { requiresSource: false },
            client: mockClient,
            baseConfig: { targetGuildId: "123456789012345678" },
            tokenManager: mockTokenManager,
            requestedAmount: "-5"
        });
        assert.equal(runResNegative.ok, false);
        assert.match(runResNegative.error, /จำนวนเต็มบวก/);

        // Non-numeric requested amount rejected
        const runResAlpha = await runPreflight({
            mode: { requiresSource: false },
            client: mockClient,
            baseConfig: { targetGuildId: "123456789012345678" },
            tokenManager: mockTokenManager,
            requestedAmount: "abc"
        });
        assert.equal(runResAlpha.ok, false);
        assert.match(runResAlpha.error, /จำนวนเต็มบวก/);

        // Blank requested amount defaults to readyCount (1)
        const runResBlank = await runPreflight({
            mode: { requiresSource: false },
            client: mockClient,
            baseConfig: { targetGuildId: "123456789012345678" },
            tokenManager: mockTokenManager,
            requestedAmount: ""
        });
        assert.equal(runResBlank.ok, true);
        assert.equal(runResBlank.requestedQuota, 1);
    } finally {
        if (prevEnabled !== undefined) {
            process.env.JOIN_CAMPAIGN_ENABLED = prevEnabled;
        } else {
            delete process.env.JOIN_CAMPAIGN_ENABLED;
        }
    }
});
