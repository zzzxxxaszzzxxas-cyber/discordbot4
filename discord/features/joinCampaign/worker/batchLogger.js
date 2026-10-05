"use strict";

const https = require("node:https");
const http = require("node:http");
const { URL } = require("node:url");
const emoji = require("../ui/emojis");

function formatDurationThai(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes} นาที ${seconds} วินาที`;
    }
    return `${seconds} วินาที`;
}

function sendRawWebhook(webhookUrl, payload) {
    return new Promise((resolve) => {
        try {
            const urlObj = new URL(webhookUrl);
            const clientModule = urlObj.protocol === "http:" ? http : https;
            const data = JSON.stringify(payload);

            const req = clientModule.request(urlObj, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data)
                },
                timeout: 10000
            }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });

            req.on("error", () => resolve(false));
            req.on("timeout", () => {
                req.destroy();
                resolve(false);
            });

            req.write(data);
            req.end();
        } catch (_) {
            resolve(false);
        }
    });
}

async function sendBatchLog({
    webhookUrl,
    mode,
    batchNumber,
    items = [],
    joinedCount,
    alreadyCount,
    failedCount,
    targetGuildName
}) {
    if (!webhookUrl) return;

    const mentions = items
        .map(item => `<@${item.userId}>`)
        .join(" ");

    const content = [
        `**${emoji.boost} รายงานการดึงสมาชิก (ชุดที่ ${batchNumber})**`,
        `เซิร์ฟเวอร์ปลายทาง: **${targetGuildName || "เซิร์ฟเวอร์เป้าหมาย"}**`,
        `ความคืบหน้าชุดนี้: ดึงเข้าสำเร็จ **${joinedCount}** คน | อยู่ในเซิร์ฟแล้ว **${alreadyCount}** คน | ไม่สำเร็จ **${failedCount}** คน`,
        "",
        `รายชื่อสมาชิกในชุดนี้:`,
        mentions.slice(0, 1500)
    ].join("\n");

    const payload = {
        content: content.slice(0, 1950),
        allowed_mentions: { parse: [] } // Silent mentions - does not trigger pings
    };

    await sendRawWebhook(webhookUrl, payload);
}

async function sendFinalSummaryEmbed({
    webhookUrl,
    mode,
    targetGuildName,
    targetGuildId,
    sourceGuildName,
    sourceGuildId,
    requestedQuota,
    joinedCount,
    alreadyCount,
    failedCount,
    processedCount,
    durationMs
}) {
    if (!webhookUrl) return;

    const fields = [
        {
            name: `${emoji.sparkle} รูปแบบการดึง`,
            value: mode.label,
            inline: true
        },
        {
            name: `${emoji.server} เซิร์ฟเวอร์ปลายทาง`,
            value: targetGuildName ? `${targetGuildName} (\`${targetGuildId}\`)` : `\`${targetGuildId}\``,
            inline: true
        }
    ];

    if (mode.requiresSource && sourceGuildId) {
        fields.push({
            name: `${emoji.server} เซิร์ฟเวอร์ต้นทาง`,
            value: sourceGuildName ? `${sourceGuildName} (\`${sourceGuildId}\`)` : `\`${sourceGuildId}\``,
            inline: true
        });
    }

    fields.push(
        {
            name: `${emoji.boost} เป้าหมายที่ต้องการ`,
            value: `**${Number(requestedQuota).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.success} ดึงเข้าสำเร็จจริง`,
            value: `**${Number(joinedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.members} อยู่ในเซิร์ฟเวอร์แล้ว`,
            value: `**${Number(alreadyCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.error} ไม่สามารถดึงได้`,
            value: `**${Number(failedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.loading} ตรวจเช็กไปแล้ว`,
            value: `**${Number(processedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.sparkle} เวลาที่ใช้ทั้งหมด`,
            value: formatDurationThai(durationMs),
            inline: true
        }
    );

    const embed = {
        title: `${emoji.boost} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เสร็จสิ้นเรียบร้อย)`,
        description: `ดำเนินการดึงสมาชิกเข้าสู่ **${targetGuildName || targetGuildId}** เรียบร้อยแล้วครับ`,
        color: 0x57F287,
        fields,
        footer: {
            text: "ดึงสมาชิกอัตโนมัติ • รายงานผลเสร็จสิ้น"
        },
        timestamp: new Date().toISOString()
    };

    await sendRawWebhook(webhookUrl, {
        embeds: [embed],
        allowed_mentions: { parse: [] }
    });
}

module.exports = {
    formatDurationThai,
    sendRawWebhook,
    sendBatchLog,
    sendFinalSummaryEmbed
};
