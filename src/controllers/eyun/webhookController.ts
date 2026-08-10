import { Request, Response } from "express"
import { getEyunService } from "../../services/eyunService"
import { processIncomingMessage, processIncomingGroupMessage } from "../../services/quoteService"
import { saveContact } from "../../services/contactService"
import { chatHistory, User } from "../../models"

export const setWebhook = async (req: Request, res: Response): Promise<void> => {
    try {
        const eyun = getEyunService()
        const { httpUrl, type } = req.body
        const result = await eyun.setHttpCallbackUrl({ httpUrl, type: type || 2 })
        res.json(result)
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error"
        res.status(500).json({ code: "1001", message, data: null })
    }
}

export const cancelWebhook = async (_req: Request, res: Response): Promise<void> => {
    try {
        const eyun = getEyunService()
        const result = await eyun.cancelHttpCallbackUrl()
        res.json(result)
    } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error"
        res.status(500).json({ code: "1001", message, data: null })
    }
}

// Webhook endpoint to receive messages from Eyun
export const webhookCallback = async (req: Request, res: Response): Promise<void> => {
    try {
        const messageData = req.body

        // Skip if message is from self (the bot itself)
        // if (messageData.data?.self === true) {
        //     console.log("[Webhook] Skipping message from self")
        //     res.json({ code: "1000", message: "ok" })
        //     return
        // }

        // Check if message is from a group (chatroom)
        const isGroupMessage = messageData.data?.fromGroup?.includes("@chatroom") || messageData.msgType === "GROUP_TEXT"

        const wId = messageData.data?.wId

        // Get bot's actual nickname from users table
        let botActualNickName: string | null = null
        if (wId) {
            const botUser = await User.findOne({ where: { wId } })
            botActualNickName = botUser?.nickName || null
            console.log("[Webhook] Bot actual nickName from DB:", botActualNickName)
        }

        // Get mentioned name from message content

        if (isGroupMessage) {
            const mentionedName = extractBotNickName(messageData.data?.content || "", [""])
            console.log("mentionedName", mentionedName)

            // Check if the mentioned name matches bot's actual nickname
            const isBotMentioned =
                (mentionedName &&
                    botActualNickName &&
                    (mentionedName.toLowerCase() === botActualNickName.toLowerCase() || mentionedName.toLowerCase() === "fandy")) ||
                false

            // Check if bot is mentioned in group message
            if (!isBotMentioned) {
                console.log("[Webhook] Group message but bot not mentioned or mentioned name doesn't match bot nickname")
                // res.json({ code: "1000", message: "ok" })
                // return
            }

            // Extract actual message content (remove @mention part)
            const actualContent = extractGroupMessageContent(messageData.data?.content || "", mentionedName || "")
            if (!actualContent.trim()) {
                console.log("[Webhook] Group message has no content after removing mention")
                res.json({ code: "1000", message: "ok" })
                return
            }

            console.log(`[Webhook] Group message mentioned bot (${mentionedName}): ${actualContent}`)

            const msgId = String(messageData.data.msgId)
            const fromWxId = messageData.data.fromUser
            const fromGroup = messageData.data.fromGroup // This is the group ID for group messages
            console.log(fromGroup + " - " + messageData.data.msgId + " : __________________________")
            console.log(messageData.data.content)
            const nickName = extractNickname(messageData.data.pushContent) || ""

            // Check duplicate by msgId
            const existing = await chatHistory.findOne({ where: { msgId } })
            if (existing) {
                console.log(`[Webhook] Message ${msgId} already processed, skipping`)
                res.json({ code: "1000", message: "ok" })
                return
            }

            // Process group message with bot mention
            await processIncomingGroupMessage({
                msgId,
                fromWxId,
                fromGroup,
                content: actualContent,
                wId,
                nickName,
                isBotMentioned,
            })

            res.json({ code: "1000", message: "ok" })
            return
        }
        console.log("[Webhook] Processing message", messageData)

        // Map Eyun webhook format to IncomingMessage format
        if (messageData.data) {
            const msgId = String(messageData.data.msgId)
            const fromWxId = messageData.data.fromUser
            const content = messageData.data.content
            const wId = messageData.data.wId
            let nickName = extractNickname(messageData.data.pushContent)

            // Get contact info and save user to database
            try {
                const contact = await saveContact(wId, fromWxId)
                // console.log("[Webhook] Contact", contact)
                if (contact && contact?.nickName && !contact.nickName.startsWith("wxid_")) {
                    nickName = contact.nickName
                }
            } catch (err) {
                console.log("[Webhook] Failed to get contact, using pushContent nickname")
            }

            // Check duplicate by msgId
            const existing = await chatHistory.findOne({ where: { msgId } })
            if (existing) {
                console.log(`[Webhook] Message ${msgId} already processed, skipping`)
                res.json({ code: "1000", message: "ok" })
                return
            }

            // if (msgType !== 1) {
            //     console.log(`[Webhook] Skipping non-text message type: ${msgType}`)
            //     return
            // }

            const mappedMessage = {
                fromWxId,
                toWxId: messageData.data.toUser,
                msgId,
                content,
                wId,
                nickName: nickName || "",
            }
            await processIncomingMessage(mappedMessage)
        }

        res.json({ code: "1000", message: "ok" })
    } catch (error) {
        console.error("[Webhook] Error processing callback:", error)
        res.json({ code: "1000", message: "ok" }) // Always return ok to prevent retries
    }
}

/**
 * Extract nickname from pushContent
 * Format: "Bruce : 把这个改成我的微信昵称" -> "Bruce"
 */
function extractNickname(pushContent: string | undefined): string | undefined {
    if (!pushContent) return undefined
    // Format mới: "Nickname在群聊中@了你" hoặc " Nickname在群聊中@了你"
    const match = pushContent.match(/^(.+?)在群聊中@了你/)
    if (match) {
        return match[1].trim()
    }

    // Format cũ: "Nickname : message"
    const parts = pushContent.split(" : ")
    return parts.length > 1 ? parts[0] : undefined
}

/**
 * Extract bot's nickname when mentioned in group message
 * If atUserList has entries, someone was mentioned (including possibly the bot)
 * Returns the nickname if found, or a placeholder "bot" if atUserList is not empty
 */
function extractBotNickName(content: string, atUserList: string[]): string | null {
    // If atUserList has entries, someone was mentioned
    if (atUserList && atUserList.length > 0) {
        // Try to extract nickname from content after @
        if (content) {
            // Match @ followed by any characters until whitespace
            const mentionMatch = content.match(/@(\S+)/)
            if (mentionMatch) {
                return mentionMatch[1]
            }
        }
        // If we can't extract from content but atUserList has values, return placeholder
        return "bot"
    }

    return null
}

/**
 * Extract actual message content from group message by removing @mention part
 * Input: "@BotName Hello world" + "BotName" -> "Hello world"
 * Also handles case where @mention is in the content
 */
function extractGroupMessageContent(content: string, botNickName: string): string {
    if (!content) return ""

    // Remove @nickname pattern from the content (not just beginning)
    const escapedNickName = botNickName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`@${escapedNickName}\\s*`)
    return content.replace(pattern, "").trim()
}

