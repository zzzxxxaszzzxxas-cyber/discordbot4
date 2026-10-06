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
const { isValidDiscordWebhookUrl, sanitizeUserFacingError, sendFinalSummaryEmbed } = require("../features/joinCampaign/worker/batchLogger");
const { runPreflight, validateGuildTargets } = require("../features/joinCampaign/services/preflightService");
const { streamCandidates } = require("../features/joinCampaign/services/candidateQueryService");
const campaignWorker = require("../features/joinCampaign/worker/campaignWorker");
const { runStartupRecovery } = require("../features/joinCampaign/recovery/startupRecovery");
const discordApi = require("../verification/utils/discordAPI");
const database = require("../../database/index");

test.beforeEach(() => {
    process.env.JOIN_CAMPAIGN_ENABLED = "true";
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

test("P0 audit: seenUsers ownership ensures new candidates are enqueued and not skipped", async () => {
    const repo = database.repositories.joinCampaign;
    const jobId = "camp_test_p0_seen_" + Date.now();
    repo.createJob({
        id: jobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5
    });

    const candidateDocs = [
        { userId: "candidate_alpha", tokenField: "oauth" },
        { userId: "candidate_beta", tokenField: "oauth" },
        { userId: "candidate_gamma", tokenField: "oauth" }
    ];

    // Real-like tokenManager that respects the contract: seenUsers is read-only exclusion check, not mutated
    const seenTracker = new Set();
    const tokenManager = {
        listAccessTokenCandidates: async ({ seenUsers }) => {
            // Must NOT mutate caller's seenUsers
            const candidates = candidateDocs.filter(d => !(seenUsers instanceof Set && seenUsers.has(d.userId)));
            return {
                candidates,
                hasMore: false
            };
        },
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    const targetGuild = {
        id: "123456789012345678",
        name: "Target Server",
        members: {
            list: async () => new Map()
        }
    };

    const mockClient = {
        guilds: {
            cache: new Map([["123456789012345678", targetGuild]])
        }
    };

    const joinedUsers = [];
    const mockDiscord = {
        addMemberToGuild: async (guildId, userId) => {
            joinedUsers.push(userId);
            return { status: 201 };
        }
    };

    const workerResult = await campaignWorker.startWorker({
        job: {
            id: jobId,
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678",
            requestedAmount: 3,
            currentConcurrency: 2
        },
        client: mockClient,
        repository: repo,
        tokenManager,
        discord: mockDiscord,
        config: { enabled: true, maxConcurrency: 2, maxRateLimitRetries: 3 }
    });

    await workerResult.workerPromise;

    const job = repo.findJobById(jobId);
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.joinedCount, 3);
    assert.deepEqual(joinedUsers.sort(), ["candidate_alpha", "candidate_beta", "candidate_gamma"].sort());
});

test("P1 audit: master switch blocks startupRecovery when JOIN_CAMPAIGN_ENABLED=false", async () => {
    const repo = database.repositories.joinCampaign;
    const jobId = "camp_test_recovery_switch_" + Date.now();
    repo.createJob({
        id: jobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 10
    });

    const prevEnabled = process.env.JOIN_CAMPAIGN_ENABLED;
    process.env.JOIN_CAMPAIGN_ENABLED = "false";
    try {
        const { runStartupRecovery } = require("../features/joinCampaign/recovery/startupRecovery");
        const res = await runStartupRecovery({
            client: { guilds: { cache: new Map() } },
            repository: repo
        });
        assert.equal(res.recovered, false);
        assert.equal(res.reason, "disabled_by_master_switch");
    } finally {
        if (prevEnabled !== undefined) {
            process.env.JOIN_CAMPAIGN_ENABLED = prevEnabled;
        } else {
            delete process.env.JOIN_CAMPAIGN_ENABLED;
        }
    }
});

test("P1 audit: graceful shutdown sets status to INTERRUPTED without completedAt and allows resume", async () => {
    const repo = database.repositories.joinCampaign;
    const jobId = "camp_test_shutdown_interrupt_" + Date.now();
    repo.createJob({
        id: jobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 10
    });

    const targetGuild = {
        id: "123456789012345678",
        name: "Target Server",
        members: {
            list: async () => new Map()
        }
    };
    const mockClient = {
        guilds: {
            cache: new Map([["123456789012345678", targetGuild]])
        }
    };

    const tokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: Array.from({ length: 10 }, (_, i) => ({ userId: `user_${i}`, tokenField: "oauth" })),
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    let joined = 0;
    const mockDiscord = {
        addMemberToGuild: async () => {
            joined++;
            if (joined === 2) {
                // Signal graceful shutdown mid-run
                campaignWorker.stopCurrentWorker();
            }
            return { status: 201 };
        }
    };

    const workerResult = await campaignWorker.startWorker({
        job: {
            id: jobId,
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678",
            requestedAmount: 10,
            currentConcurrency: 1
        },
        client: mockClient,
        repository: repo,
        tokenManager,
        discord: mockDiscord,
        config: { enabled: true, maxConcurrency: 1, maxRateLimitRetries: 3 }
    });

    await workerResult.workerPromise;

    const job = repo.findJobById(jobId);
    assert.equal(job.status, "INTERRUPTED");
    assert.equal(job.completedAt, null);

    // findActiveRunningJob must find the INTERRUPTED job for auto-resume
    const resumable = repo.findActiveRunningJob();
    assert.ok(resumable);
    assert.equal(resumable.id, jobId);
});

test("P2 audit: createItems returns exact inserted count and getTrackedUserIds works", () => {
    const repo = database.repositories.joinCampaign;
    const campaignId = "camp_test_create_count_" + Date.now();

    const insertedFirst = repo.createItems(campaignId, [
        { userId: "u1", tokenField: "oauth" },
        { userId: "u2", tokenField: "oauth" }
    ]);
    assert.equal(insertedFirst, 2);

    // Insert with duplicates ignored
    const insertedSecond = repo.createItems(campaignId, [
        { userId: "u2", tokenField: "oauth" }, // duplicate -> ignored
        { userId: "u3", tokenField: "oauth" }  // new -> inserted
    ]);
    assert.equal(insertedSecond, 1);

    const tracked = repo.getTrackedUserIds(campaignId);
    const completed = repo.getCompletedUserIds(campaignId);
    assert.equal(tracked.size, 3);
    assert.deepEqual(Array.from(tracked).sort(), ["u1", "u2", "u3"].sort());
    assert.deepEqual(Array.from(completed).sort(), ["u1", "u2", "u3"].sort());
});

test("P1 audit: confirmAndStartCampaign fails closed and creates no job when fresh target member fetch throws", async () => {
    const repo = database.repositories.joinCampaign;
    const mode = modeRegistry.getMode("ALL_TO_TARGET");

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    members: {
                        me: { permissions: { has: () => true } },
                        // fetch throws error simulating Discord API network failure
                        fetch: async () => {
                            const err = new Error("Discord API 503 Service Unavailable");
                            err.code = "FETCH_MEMBERS_FAILED";
                            throw err;
                        }
                    }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [{ userId: "u1", tokenField: "oauth" }],
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    // Stage session with preflight
    const stageResult = await joinCampaignService.stageCampaign({
        client: {
            guilds: {
                cache: new Map([
                    ["123456789012345678", {
                        id: "123456789012345678",
                        name: "Target Server",
                        memberCount: 1,
                        members: {
                            me: { permissions: { has: () => true } },
                            fetch: async () => new Map()
                        }
                    }]
                ])
            }
        },
        repository: repo,
        mode,
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: "10",
        tokenManager: mockTokenManager
    });

    assert.ok(stageResult.ok);
    const stageId = stageResult.stageId;

    // Confirm execution when client fresh member fetch fails
    const confirmResult = await joinCampaignService.confirmAndStartCampaign({
        stageId,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager
    });

    // Must fail closed with error
    assert.equal(confirmResult.ok, false);
    assert.ok(confirmResult.error.includes("ไม่สามารถตรวจสอบรายชื่อสมาชิกปัจจุบัน"));

    // No active or running job must be created in SQLite
    const active = repo.findActiveRunningJob();
    assert.equal(active, null);
});

test("P1 audit: worker interrupted sleep wakes immediately during long 429 backoff when stopCurrentWorker is called", async () => {
    const repo = database.repositories.joinCampaign;
    const jobId = "camp_test_sleep_wake_" + Date.now();

    repo.createJob({
        id: jobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "STAGE",
        requestedAmount: 10
    });

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    memberCount: 1,
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const tokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [{ userId: "user_429", tokenField: "oauth" }],
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    const mockDiscord = {
        addMemberToGuild: async () => {
            // Simulate 429 with 300-second retryAfter
            return { status: 429, retryAfter: 300000 };
        }
    };

    const workerResult = await campaignWorker.startWorker({
        job: {
            id: jobId,
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678",
            requestedAmount: 10,
            currentConcurrency: 1
        },
        client: mockClient,
        repository: repo,
        tokenManager,
        discord: mockDiscord,
        config: { enabled: true, maxConcurrency: 1, maxRateLimitRetries: 3 }
    });

    // Wait a brief tick for the 429 to register and worker to enter backoff sleep
    await new Promise(r => setTimeout(r, 60));

    const startTime = Date.now();
    // Signal graceful shutdown while worker is sleeping in 300-second backoff
    campaignWorker.stopCurrentWorker();

    await workerResult.workerPromise;
    const elapsed = Date.now() - startTime;

    // Worker must wake up and resolve promptly (well within 1000ms, not 300,000ms!)
    assert.ok(elapsed < 1000, `Worker took ${elapsed}ms to exit, expected < 1000ms`);

    const job = repo.findJobById(jobId);
    assert.equal(job.status, "INTERRUPTED");
    assert.equal(job.completedAt, null);
});

test("P1 audit: quota met takes precedence over guild full error (status COMPLETED)", async () => {
    const repo = database.repositories.joinCampaign;
    const jobId = "camp_test_quota_precedence_" + Date.now();

    repo.createJob({
        id: jobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "STAGE",
        requestedAmount: 2
    });

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    memberCount: 1,
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const tokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [
                { userId: "u1", tokenField: "oauth" },
                { userId: "u2", tokenField: "oauth" },
                { userId: "u3", tokenField: "oauth" }
            ],
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    const mockDiscord = {
        addMemberToGuild: async (targetGuildId, userId) => {
            if (userId === "u3") {
                // Returns 30005 (guild full) concurrently
                return { status: 400, code: 30005, error: { code: 30005, message: "Maximum number of guild members reached" } };
            }
            // u1 and u2 succeed, fulfilling requestedAmount = 2
            return { status: 201 };
        }
    };

    const workerResult = await campaignWorker.startWorker({
        job: {
            id: jobId,
            mode: "ALL_TO_TARGET",
            targetGuildId: "123456789012345678",
            requestedAmount: 2,
            currentConcurrency: 4
        },
        client: mockClient,
        repository: repo,
        tokenManager,
        discord: mockDiscord,
        config: { enabled: true, maxConcurrency: 4, maxRateLimitRetries: 1 }
    });

    await workerResult.workerPromise;

    const job = repo.findJobById(jobId);
    assert.equal(job.joinedCount, 2);
    // When joinedCount meets requestedQuota, status MUST be COMPLETED even if a concurrent task encountered code 30005
    assert.equal(job.status, "COMPLETED");
});

test("P2 audit: candidate query skips tokens with refreshFailCount >= failMax matching getAccessToken contract", async () => {
    const mockModel = {
        find: () => ({
            select: () => ({
                sort: () => ({
                    limit: () => ({
                        lean: async () => [
                            {
                                _id: "doc1",
                                discord: { userId: "user_exhausted" },
                                oauth: {
                                    encryptedAccessToken: "enc_acc",
                                    encryptedRefreshToken: "enc_ref",
                                    refreshFailCount: 5,
                                    scope: "guilds.join"
                                }
                            },
                            {
                                _id: "doc2",
                                discord: { userId: "user_valid" },
                                oauth: {
                                    encryptedAccessToken: "enc_acc_2",
                                    encryptedRefreshToken: "enc_ref_2",
                                    refreshFailCount: 0,
                                    scope: "guilds.join"
                                }
                            }
                        ]
                    })
                })
            })
        })
    };

    const oauthTokenManager = require("../core/oauthTokenManager");
    const result = await oauthTokenManager.listAccessTokenCandidates({
        allowAllGuilds: true,
        model: mockModel,
        env: { OAUTH_TOKEN_REFRESH_FAIL_MAX: "3" }
    });

    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0].userId, "user_valid");
});

test("P2 audit: confirmAndStartCampaign fails closed when fresh ready count is 0", async () => {
    const repo = database.repositories.joinCampaign;
    const mode = modeRegistry.getMode("ALL_TO_TARGET");

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [{ userId: "u1", tokenField: "oauth" }],
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    // Stage session with preflight where target has 0 member candidates
    const stageResult = await joinCampaignService.stageCampaign({
        client: {
            guilds: {
                cache: new Map([
                    ["123456789012345678", {
                        id: "123456789012345678",
                        name: "Target Server",
                        memberCount: 1,
                        members: {
                            me: { permissions: { has: () => true } },
                            fetch: async () => new Map()
                        }
                    }]
                ])
            }
        },
        repository: repo,
        mode,
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: "10",
        tokenManager: mockTokenManager
    });

    assert.ok(stageResult.ok);
    const stageId = stageResult.stageId;

    // Simulate that by confirm-time, u1 has joined the target server (fresh fetch returns u1)
    const mockClientWithU1 = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    memberCount: 1,
                    members: {
                        me: { permissions: { has: () => true } },
                        fetch: async () => new Map([["u1", { id: "u1" }]])
                    }
                }]
            ])
        }
    };

    const confirmResult = await joinCampaignService.confirmAndStartCampaign({
        stageId,
        client: mockClientWithU1,
        repository: repo,
        tokenManager: mockTokenManager
    });

    assert.equal(confirmResult.ok, false);
    assert.match(confirmResult.error, /ไม่พบสมาชิกที่พร้อมดึงเข้าเซิร์ฟเวอร์/);

    const active = repo.findActiveRunningJob();
    assert.equal(active, null);
});

test("P2 audit: JoinCampaignRepository countPendingItems supports status parameter and separates pending from processing", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_count_test_" + Date.now();

    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 5
    });

    repo.createItems(testJobId, [
        { userId: "user_p1", tokenField: "oauth" },
        { userId: "user_p2", tokenField: "oauth" },
        { userId: "user_p3", tokenField: "oauth" }
    ]);

    // Claim one item so it becomes 'processing'
    const claimed = repo.claimNextPendingItem(testJobId, 30000);
    assert.ok(claimed);

    // Default countPendingItems should count only 'pending' items (2 items)
    const pendingOnly = repo.countPendingItems(testJobId);
    assert.equal(pendingOnly, 2);

    // countPendingItems with 'all' should count pending + processing (3 items)
    const allActive = repo.countPendingItems(testJobId, "all");
    assert.equal(allActive, 3);
});

test("P1 audit #1: Early-return outcomes immediately checkpoint job counters and reconcile on restart", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_early_return_" + Date.now();

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 5
    });

    const targetMemberIds = new Set(["already_u1", "already_u2"]);

    // Stream yields 2 already_member candidates and 1 token_unavailable candidate
    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [
                { userId: "already_u1", tokenField: "oauth" },
                { userId: "already_u2", tokenField: "oauth" },
                { userId: "no_token_u3", tokenField: "oauth" }
            ],
            hasMore: false
        }),
        getAccessToken: async ({ userId }) => {
            if (userId === "no_token_u3") return { accessToken: null };
            return { accessToken: "valid" };
        }
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    // Run worker
    const startResult = await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        targetMemberIds,
        discord: { addMemberToGuild: async () => ({ ok: true, status: 201 }) }
    });

    await startResult.workerPromise;

    // Verify SQLite job counters are immediately updated despite early returns
    const finalJob = repo.findJobById(testJobId);
    assert.equal(finalJob.alreadyCount, 2, "already_count should be 2 in SQLite");
    assert.equal(finalJob.failedCount, 1, "failed_count should be 1 in SQLite");
    assert.equal(finalJob.processedCount, 3, "processed_count should be 3 in SQLite");

    // Test reconcileJobCounters recovers exact counts from items
    const reconciled = repo.reconcileJobCounters(testJobId);
    assert.equal(reconciled.alreadyCount, 2);
    assert.equal(reconciled.failedCount, 1);
    assert.equal(reconciled.processedCount, 3);
});

test("P1 audit #2: Item lease renewal heartbeat and local in-flight tracking prevent duplicate claim", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_lease_test_" + Date.now();

    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5
    });

    repo.createItems(testJobId, [
        { userId: "u_slow", tokenField: "oauth" }
    ]);

    // Claim item with 120s base lease
    const claimed = repo.claimNextPendingItem(testJobId, 120000);
    assert.ok(claimed);
    assert.equal(claimed.userId, "u_slow");
    assert.ok(claimed.leasedUntil > Date.now());

    // Test renewItemLease extends lease further
    const initialLeasedUntil = claimed.leasedUntil;
    const renewed = repo.renewItemLease(testJobId, "u_slow", 180000);
    assert.equal(renewed, true);

    const reloadedItem = repo.db.prepare("SELECT leased_until FROM join_campaign_items WHERE campaign_id = ? AND user_id = ?").get(testJobId, "u_slow");
    assert.ok(reloadedItem.leased_until > initialLeasedUntil);
});

test("P1 audit #3: started_by_channel_id is persisted on job and panel retains activeJobId on INTERRUPTED", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_panel_persist_" + Date.now();
    const testChannelId = "chan_987654321";

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 5,
        startedByChannelId: testChannelId
    });

    assert.equal(job.startedByChannelId, testChannelId, "startedByChannelId must be persisted in SQLite");

    // Save panel associated with this job
    repo.savePanel({
        messageId: "msg_123",
        channelId: testChannelId,
        guildId: "123456789012345678",
        mode: "ALL_TO_TARGET",
        activeJobId: testJobId,
        lastReadyCount: 5
    });

    // Verify findPanelByActiveJobId locates the panel
    const foundPanel = repo.findPanelByActiveJobId(testJobId);
    assert.ok(foundPanel);
    assert.equal(foundPanel.channelId, testChannelId);

    // Call _finishPanelUpdate with INTERRUPTED status
    let editedPayload = null;
    const mockChannel = {
        messages: {
            fetch: async () => ({
                edit: async (payload) => { editedPayload = payload; }
            })
        }
    };
    const mockClient = {
        channels: { fetch: async () => mockChannel },
        guilds: { cache: new Map() }
    };

    await campaignWorker._finishPanelUpdate({
        job,
        client: mockClient,
        repository: repo,
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        joinedCount: 3,
        alreadyCount: 1,
        failedCount: 0,
        finalStatus: "INTERRUPTED",
        targetGuildName: "Target Guild",
        tokenManager: {}
    });

    // Verify that panel retains activeJobId = testJobId (NOT cleared to null) because campaign is INTERRUPTED
    const updatedPanel = repo.findPanelByChannelId(testChannelId);
    assert.equal(updatedPanel.activeJobId, testJobId, "INTERRUPTED panel must keep activeJobId to resume");
    assert.match(updatedPanel.lastStatusSummary, /หยุดชั่วคราวเพื่อรีสตาร์ต/);
});

test("P1 audit #4: sendFinalSummaryEmbed formats INTERRUPTED with blurple color and pause/auto-resume wording", async () => {
    let sentPayload = null;
    const https = require("node:https");
    const origRequest = https.request;

    https.request = (url, options, callback) => {
        return {
            write: (data) => {
                try { sentPayload = JSON.parse(data); } catch (_) {}
            },
            end: () => {
                if (callback) {
                    callback({
                        statusCode: 204,
                        resume: () => {}
                    });
                }
            },
            on: () => {},
            destroy: () => {}
        };
    };

    try {
        await sendFinalSummaryEmbed({
            webhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_12345",
            mode: modeRegistry.getMode("ALL_TO_TARGET"),
            targetGuildName: "Target Guild",
            targetGuildId: "123456789012345678",
            requestedQuota: 100,
            joinedCount: 35,
            alreadyCount: 10,
            failedCount: 5,
            processedCount: 50,
            durationMs: 12000,
            finalStatus: "INTERRUPTED",
            statusReason: "บอทปิดระบบชั่วคราว"
        });

        assert.ok(sentPayload, "Webhook payload must be sent");
        assert.ok(sentPayload.embeds && sentPayload.embeds.length > 0);
        const embed = sentPayload.embeds[0];

        assert.equal(embed.color, 0x5865F2, "INTERRUPTED embed color must be Blurple (0x5865F2)");
        assert.match(embed.title, /หยุดชั่วคราวเพื่อรีสตาร์ต/);
        assert.match(embed.description, /กลับมาทำงานต่ออัตโนมัติ/);
        assert.ok(!embed.title.includes("เสร็จสิ้นสมบูรณ์"), "INTERRUPTED must not say finished successfully");

        const statusField = embed.fields.find(f => f.name.includes("สถานะสุดท้าย"));
        assert.ok(statusField);
        assert.match(statusField.value, /หยุดชั่วคราว \(รอทำต่ออัตโนมัติ\)/);
    } finally {
        https.request = origRequest;
    }
});

test("P2 audit #22: handleJoinPanelCommand rejects creating new panel if campaign is currently running", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_running_lock_" + Date.now();

    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 10,
        selectedAmount: 5
    });

    let replyData = null;
    const mockInteraction = {
        guild: { id: "123456789012345678" },
        user: { id: "123456789012345678" },
        channelId: "chan_active",
        options: {
            getString: () => null
        },
        reply: async (data) => {
            replyData = data;
            return data;
        }
    };

    process.env.OWNER_ID = "123456789012345678";

    await handleJoinPanelCommand(mockInteraction, {});

    assert.ok(replyData, "Reply must be sent");
    assert.equal(replyData.ephemeral, true);
    assert.match(replyData.content, /กำลังมีงานดึงสมาชิกทำงานอยู่ในระบบ/);
});

test("P2 audit #23: tokenManager.getAccessToken receives marginMs configured from refreshMarginMs", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_margin_test_" + Date.now();

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 1,
        selectedAmount: 1
    });

    let passedMarginMs = null;
    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [{ userId: "u_margin", tokenField: "oauth" }],
            hasMore: false
        }),
        getAccessToken: async (opts) => {
            passedMarginMs = opts.marginMs;
            return { accessToken: "valid_token" };
        }
    };

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const startResult = await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        targetMemberIds: new Set(),
        discord: { addMemberToGuild: async () => ({ ok: true, status: 201 }) }
    });

    await startResult.workerPromise;

    const { getJoinCampaignConfig } = require("../features/joinCampaign/config");
    const expectedMargin = getJoinCampaignConfig().refreshMarginMs;
    assert.equal(passedMarginMs, expectedMargin, "marginMs must match JOIN_CAMPAIGN_REFRESH_MARGIN_MS");
});

test("P2 audit #27: runStartupRecovery prevents concurrent execution via activeRecoveryPromise", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "rec_concurrent_" + Date.now();

    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "INTERRUPTED",
        requestedAmount: 10,
        selectedAmount: 5
    });

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target",
                    memberCount: 1,
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({ candidates: [], hasMore: false }),
        getAccessToken: async () => ({ accessToken: "t" })
    };

    // Trigger two recoveries concurrently
    const promise1 = runStartupRecovery({ client: mockClient, repository: repo, tokenManager: mockTokenManager, discord: {} });
    const promise2 = runStartupRecovery({ client: mockClient, repository: repo, tokenManager: mockTokenManager, discord: {} });

    // Both should return the same active promise
    assert.strictEqual(promise1, promise2, "Concurrent recoveries must return identical in-flight promise");

    const [res1, res2] = await Promise.all([promise1, promise2]);
    assert.equal(res1.recovered, true);
    assert.equal(res2.recovered, true);

    await campaignWorker.waitForCompletion();
});

test("P1 audit: Hard crash mid-processing before terminal outcome correctly recovers processedCount on restart", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "hard_crash_job_" + Date.now();

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 3,
        selectedAmount: 3,
        joinedCount: 0,
        processedCount: 0
    });

    // Create 3 candidate items
    repo.createItems(testJobId, [
        { userId: "crash_user_1", tokenField: "oauth" },
        { userId: "crash_user_2", tokenField: "oauth" },
        { userId: "crash_user_3", tokenField: "oauth" }
    ]);

    // Simulate Item 1 completed normally
    const item1 = repo.claimNextPendingItem(testJobId);
    assert.ok(item1);
    assert.equal(item1.userId, "crash_user_1");
    repo.updateItemStatus(testJobId, "crash_user_1", "joined");
    repo.updateJob(testJobId, { joinedCount: 1, processedCount: 1 });

    // Simulate Item 2 claimed for processing, but process CRASHES before recordItemOutcome / checkpoint
    const item2 = repo.claimNextPendingItem(testJobId);
    assert.ok(item2);
    assert.equal(item2.userId, "crash_user_2");
    assert.ok(item2.processingStartedAt > 0, "processingStartedAt must be recorded in SQLite on claim");
    assert.equal(item2.attempts, 1);
    assert.equal(item2.status, "processing");

    // At the moment of crash, job.processedCount is still 1 in SQLite, but item2 was claimed!
    const jobBeforeRecovery = repo.findJobById(testJobId);
    assert.equal(jobBeforeRecovery.processedCount, 1);

    // Simulate Restart Recovery
    const reconciled = repo.reconcileJobCounters(testJobId);
    assert.ok(reconciled);
    assert.equal(reconciled.joinedCount, 1);
    assert.equal(reconciled.processedCount, 2, "reconcileJobCounters must count item2 because processing_started_at is set");

    // Release leases back to pending for resumed worker
    repo.releaseExpiredLeases(testJobId, true);
    const item2Row = repo.db.prepare("SELECT * FROM join_campaign_items WHERE campaign_id = ? AND user_id = ?").get(testJobId, "crash_user_2");
    assert.equal(item2Row.status, "pending");
    assert.ok(item2Row.processing_started_at > 0, "processing_started_at must be preserved after lease release");

    // Resumed worker picks up the campaign
    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };
    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({ candidates: [], hasMore: false }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    const startResult = await campaignWorker.startWorker({
        job: reconciled,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        targetMemberIds: new Set(["crash_user_1"]),
        discord: { addMemberToGuild: async () => ({ ok: true, status: 201 }) }
    });

    await startResult.workerPromise;

    const finalJob = repo.findJobById(testJobId);
    assert.equal(finalJob.status, "COMPLETED");
    assert.equal(finalJob.joinedCount, 3, "All 3 items should join (1 prior + 2 resumed)");
    assert.equal(finalJob.processedCount, 3, "Processed count should accurately reflect 3 distinct users without duplicate counting");
});

test("P1 audit: confirmAndStartCampaign failure when startWorker throws marks job FAILED and clears panel activeJobId", async () => {
    const repo = database.repositories.joinCampaign;
    const channelId = "chan_fail_test_" + Date.now();
    const messageId = "msg_fail_test_" + Date.now();

    // Persist panel
    repo.savePanel({
        messageId,
        channelId,
        guildId: "123456789012345678",
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        activeJobId: null,
        requestedAmount: 5,
        lastReadyCount: 10,
        lastStatusSummary: null
    });

    // Mock client with target guild and channel
    let editedPayload = null;
    const mockMessage = {
        id: messageId,
        edit: async (payload) => {
            editedPayload = payload;
            return mockMessage;
        }
    };
    const mockChannel = {
        id: channelId,
        messages: {
            fetch: async (id) => (id === messageId ? mockMessage : null)
        }
    };
    const mockClient = {
        channels: {
            fetch: async (id) => (id === channelId ? mockChannel : null)
        },
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    memberCount: 1,
                    members: {
                        me: { permissions: { has: () => true } },
                        fetch: async () => new Map()
                    }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [{ userId: "u1", tokenField: "oauth" }],
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "t" })
    };

    // Stage a campaign
    const stageResult = await joinCampaignService.stageCampaign({
        client: mockClient,
        repository: repo,
        mode: modeRegistry.getMode("ALL_TO_TARGET"),
        baseConfig: { targetGuildId: "123456789012345678" },
        requestedAmount: 5,
        startedByUserId: "admin1",
        channelId,
        tokenManager: mockTokenManager
    });
    assert.equal(stageResult.ok, true);

    // Mock startWorker to throw an error
    const origStartWorker = campaignWorker.startWorker.bind(campaignWorker);
    campaignWorker.startWorker = async () => {
        throw new Error("Simulated worker start explosion");
    };

    try {
        const confirmResult = await joinCampaignService.confirmAndStartCampaign({
            stageId: stageResult.stageId,
            client: mockClient,
            repository: repo,
            tokenManager: mockTokenManager
        });

        assert.equal(confirmResult.ok, false);
        assert.match(confirmResult.error, /Simulated worker start explosion/);

        // Verify SQLite panel state: activeJobId must NOT point to the failed job!
        const updatedPanel = repo.findPanelByChannelId(channelId);
        assert.ok(updatedPanel);
        assert.equal(updatedPanel.activeJobId, null, "Panel activeJobId must be cleared to null on worker start failure");
        assert.match(updatedPanel.lastStatusSummary, /เกิดข้อผิดพลาด/);

        // Verify Discord message was edited with error payload
        assert.ok(editedPayload, "Panel message on Discord must be edited to show error");
    } finally {
        campaignWorker.startWorker = origStartWorker;
    }
});

test("P2 audit: Real lease heartbeat renewal extends leased_until and prevents concurrent claim", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "heartbeat_test_" + Date.now();

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 1,
        selectedAmount: 1
    });

    repo.createItems(testJobId, [{ userId: "hb_user", tokenField: "oauth" }]);

    let initialLeaseUntil = 0;
    let renewedLeaseUntil = 0;
    let concurrentClaimResult = "UNTESTED";

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({
            candidates: [{ userId: "hb_user", tokenField: "oauth" }],
            hasMore: false
        }),
        getAccessToken: async () => ({ accessToken: "t" })
    };

    // Spy on claimNextPendingItem to capture initialLeaseUntil
    const origClaim = repo.claimNextPendingItem.bind(repo);
    repo.claimNextPendingItem = (...args) => {
        const item = origClaim(...args);
        if (item && item.userId === "hb_user" && initialLeaseUntil === 0) {
            initialLeaseUntil = item.leasedUntil;
        }
        return item;
    };

    // Spy on renewItemLease
    const origRenew = repo.renewItemLease.bind(repo);
    let renewPromiseResolve;
    const renewCalled = new Promise(resolve => { renewPromiseResolve = resolve; });

    repo.renewItemLease = (jId, uId, extMs) => {
        const res = origRenew(jId, uId, extMs);
        const item = repo.db.prepare("SELECT leased_until FROM join_campaign_items WHERE campaign_id = ? AND user_id = ?").get(jId, uId);
        renewedLeaseUntil = item.leased_until;
        renewPromiseResolve();
        return res;
    };

    // Override setInterval in worker task so heartbeat fires quickly in test
    const origSetInterval = global.setInterval;
    global.setInterval = (fn, _ms) => {
        return origSetInterval(fn, 10); // fire every 10ms instead of 15s for fast test
    };

    try {
        const startResult = await campaignWorker.startWorker({
            job,
            client: mockClient,
            repository: repo,
            tokenManager: mockTokenManager,
            targetMemberIds: new Set(),
            discord: {
                addMemberToGuild: async () => {
                    // Wait for heartbeat renew to trigger
                    await renewCalled;

                    // Concurrently attempt to claim item while heartbeat is renewing
                    const claim = repo.claimNextPendingItem(testJobId);
                    concurrentClaimResult = claim; // should be null!

                    return { ok: true, status: 201 };
                }
            }
        });

        await startResult.workerPromise;

        assert.ok(initialLeaseUntil > 0, "initialLeaseUntil must be captured on claim");
        assert.ok(renewedLeaseUntil > initialLeaseUntil, "Heartbeat must extend leased_until");
        assert.strictEqual(concurrentClaimResult, null, "Concurrent worker must NOT be able to claim item while heartbeat lease is active");
    } finally {
        global.setInterval = origSetInterval;
        repo.renewItemLease = origRenew;
        repo.claimNextPendingItem = origClaim;
    }
});

test("P2 audit: handleJoinPanelCommand rejects when active job has INTERRUPTED status", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "camp_interrupted_lock_" + Date.now();

    repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "INTERRUPTED",
        requestedAmount: 10,
        selectedAmount: 5
    });

    let replyData = null;
    const mockInteraction = {
        guild: { id: "123456789012345678" },
        user: { id: "123456789012345678" },
        channelId: "chan_active_interrupted",
        options: {
            getString: () => null
        },
        reply: async (data) => {
            replyData = data;
            return data;
        }
    };

    process.env.OWNER_ID = "123456789012345678";

    await handleJoinPanelCommand(mockInteraction, {});

    assert.ok(replyData, "Reply must be sent");
    assert.equal(replyData.ephemeral, true);
    assert.match(replyData.content, /กำลังมีงานดึงสมาชิก.*INTERRUPTED/);
});

test("P2 audit: stopCurrentWorker aborts in-flight task via AbortSignal cleanly", async () => {
    const repo = database.repositories.joinCampaign;
    const testJobId = "abort_test_" + Date.now();

    const job = repo.createJob({
        id: testJobId,
        mode: "ALL_TO_TARGET",
        targetGuildId: "123456789012345678",
        status: "RUNNING",
        requestedAmount: 5,
        selectedAmount: 5
    });

    repo.createItems(testJobId, [{ userId: "u_abort", tokenField: "oauth" }]);

    const mockClient = {
        guilds: {
            cache: new Map([
                ["123456789012345678", {
                    id: "123456789012345678",
                    name: "Target Server",
                    members: { fetch: async () => new Map() }
                }]
            ])
        }
    };

    const mockTokenManager = {
        listAccessTokenCandidates: async () => ({ candidates: [], hasMore: false }),
        getAccessToken: async () => ({ accessToken: "valid_token" })
    };

    let signalObserved = null;
    let taskAborted = false;

    const startResult = await campaignWorker.startWorker({
        job,
        client: mockClient,
        repository: repo,
        tokenManager: mockTokenManager,
        targetMemberIds: new Set(),
        discord: {
            addMemberToGuild: async (_gId, _uId, _tok, opts) => {
                signalObserved = opts?.signal;
                assert.ok(signalObserved, "AbortSignal must be passed to addMemberToGuild");

                return new Promise((resolve, reject) => {
                    opts.signal.addEventListener("abort", () => {
                        taskAborted = true;
                        const err = new Error("The operation was aborted");
                        err.name = "AbortError";
                        reject(err);
                    });
                });
            }
        }
    });

    // Give worker microtasks to enter addMemberToGuild
    await new Promise(resolve => setTimeout(resolve, 50));

    // Call stopCurrentWorker while task is in flight
    campaignWorker.stopCurrentWorker();

    await startResult.workerPromise;

    assert.equal(taskAborted, true, "In-flight task must observe abort signal event");
    const updatedJob = repo.findJobById(testJobId);
    assert.equal(updatedJob.status, "INTERRUPTED", "Stopping worker must transition job to INTERRUPTED");
});


