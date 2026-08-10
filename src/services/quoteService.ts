import { getEyunService } from "./eyunService"
import { sendMessageToCoze } from "./cozeService"
import { getOpenClawService } from "./openclawService"
import { getContactByWxId } from "./contactService"
import { chatHistory } from "../models"
import { isWhitelisted } from "../config/whitelist"
import { isBlacklisted } from "../config/blacklist"

interface IncomingMessage {
    msgId: string
    fromWxId: string
    toWxId: string
    content: string
    wId: string
    nickName: string
}

interface IncomingGroupMessage {
    msgId: string
    fromWxId: string
    fromGroup: string
    content: string
    wId: string
    nickName: string
    isBotMentioned: boolean
}

const ERROR_MESSAGE = "抱歉，系统正在忙碌，请稍后再试。谢谢！"

/**
 * Process incoming webhook message and auto-reply using Coze AI
 * NOTE: Duplicate check is done in webhookController before calling this
 */
export const processIncomingMessage = async (message: IncomingMessage): Promise<void> => {
    const { msgId, fromWxId, content, wId, nickName } = message

    // Only process text messages

    console.log(`[Quote] Processing message from ${fromWxId}: ${content}`)

    if (!wId) {
        console.log("[Quote] No wId provided in webhook")
        return
    }

    if (!msgId || !content) {
        console.log("[Quote] No msgId or content provided in webhook")
        return
    }

    // Skip blacklisted users
    if (isBlacklisted(fromWxId)) {
        console.log(`[Quote] ${fromWxId} is blacklisted, skipping`)
        return
    }
    // let chatHistoryEntry = null
    let chatHistoryEntry = await chatHistory.findOne({ where: { msgId } })
    if (!chatHistoryEntry) {
        chatHistoryEntry = await chatHistory.create({
            msgId,
            wId,
            fromWxId,
            content,
        })
    }

    try {
        // Mark as pending before calling Coze

        let aiResponse: string | null = null

        if (isWhitelisted(fromWxId)) {
            // User is in whitelist → use OpenClaw
            console.log(`[Quote] ${fromWxId} is in whitelist, using OpenClaw`)
            const openclaw = getOpenClawService()
            aiResponse = await openclaw.chatWithContext(nickName, content, nickName)
        } else {
            // User is not in whitelist → use Coze
            console.log(`[Quote] ${fromWxId} is not in whitelist, using Coze`)
            aiResponse = await sendMessageToCoze(content, fromWxId)
        }
        if (aiResponse) {
            const eyun = getEyunService()
            // Check if OpenClaw returned "No response"
            if (aiResponse === "No response from OpenClaw.") {
                console.log("[Quote] OpenClaw returned no response, using error message")
                await eyun.sendText({ wId, wcId: fromWxId, content: ERROR_MESSAGE })
                await chatHistoryEntry.update({ reply: ERROR_MESSAGE })
            } else {
                console.log(`[Quote] AI response: ${aiResponse}`)
                await eyun.sendText({ wId, wcId: fromWxId, content: aiResponse })
                console.log(`[Quote] Sent reply to ${fromWxId}: ${aiResponse}`)
                await chatHistoryEntry.update({ reply: aiResponse })
            }
        } else {
            console.log("[Quote] AI failed, notifying customer to retry")
            await chatHistoryEntry.update({ reply: ERROR_MESSAGE })
        }
    } catch (error) {
        console.error(`[Quote] Failed to process message:`, error)
        if (isWhitelisted(fromWxId)) {
            console.log(`[Quote] ${fromWxId} is in whitelist, sending error message to OpenClaw`)
        } else {
            console.log(`[Quote] ${fromWxId} is not in whitelist, sending error message to Coze`)
        }
        const eyun = getEyunService()
        await eyun.sendText({ wId, wcId: fromWxId, content: ERROR_MESSAGE })
        console.log(`[Quote] Sent error message to ${fromWxId} - ${msgId}: ${ERROR_MESSAGE}`)
        if (chatHistoryEntry) {
            await chatHistoryEntry.update({ reply: ERROR_MESSAGE })
        }
    }
}

/**
 * Process incoming group message when bot is mentioned
 * Sends reply to group with @mention to the sender
 */
export const processIncomingGroupMessage = async (message: IncomingGroupMessage): Promise<void> => {
    const { msgId, fromWxId, fromGroup, content, wId, nickName, isBotMentioned } = message

    if (!wId) {
        console.log("[Quote] No wId provided in webhook")
        return
    }
    if (!msgId || !content) {
        console.log("[Quote] No msgId or content provided in webhook")
        return
    }

    // Skip blacklisted users
    if (isBlacklisted(fromWxId)) {
        console.log(`[Quote] ${fromWxId} is blacklisted, skipping`)
        return
    }

    let chatHistoryEntry = await chatHistory.findOne({ where: { msgId } })
    console.log(`[Quote] Chat history entry: ${chatHistoryEntry}`)
    if (!chatHistoryEntry) {
        console.log(`[Quote] No chat history entry found, creating new one`)
        chatHistoryEntry = await chatHistory.create({
            msgId,
            wId,
            fromWxId,
            content,
        })
    }
    try {
        const openclaw = getOpenClawService()
        const aiResponse = await openclaw.chatWithContext(nickName, content, fromGroup)
        if (!isBotMentioned) {
            console.log(`[Quote] No mention of bot, skipping`)
            return
        }
        console.log(`[Quote] Processing group message from ${fromWxId} in ${fromGroup}: ${content}`)

        // Get sender's nickname from contacts
        const contact = await getContactByWxId(fromWxId)
        const senderNickName = contact?.nickName || nickName

        if (aiResponse) {
            console.log(`[Quote] AI response: ${aiResponse}`)
            const eyun = getEyunService()
            // Send to group with @mention to the sender
            await eyun.sendText({
                wId,
                wcId: fromGroup,
                content: `@${senderNickName} ${aiResponse}`,
                at: fromWxId,
            })
            console.log(`[Quote] Sent reply to group ${fromGroup}: ${aiResponse}`)
            if (chatHistoryEntry) {
                await chatHistoryEntry.update({ reply: `@${senderNickName} ${aiResponse}` })
            }
        } else {
            console.log("[Quote] AI failed, notifying customer to retry")
            if (chatHistoryEntry) {
                await chatHistoryEntry.update({ reply: `@${senderNickName} ${ERROR_MESSAGE}` })
            }
        }
    } catch (error) {
        console.error(`[Quote] Failed to process group message:`, error)

        if (isBotMentioned) {
            const eyun = getEyunService()
            try {
                await eyun.sendText({
                    wId,
                    wcId: fromGroup,
                    content: ERROR_MESSAGE,
                    at: fromWxId,
                })
                console.log(`[Quote] Sent error message to ${fromGroup} - ${msgId}: ${ERROR_MESSAGE}`)
            } catch (sendError) {
                console.error(`[Quote] Failed to send error message:`, sendError)
            }
        } else {
            console.log(`[Quote] No mention of bot, skipping`)
        }

        if (chatHistoryEntry) {
            await chatHistoryEntry.update({ reply: ERROR_MESSAGE })
        }
    }
}
