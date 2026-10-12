import { Request, Response } from "express"
import { getEyunService } from "../../services/eyunService"
import { processIncomingMessage, processIncomingGroupMessage } from "../../services/quoteService"
import { saveContact } from "../../services/contactService"
import { freightService } from "../../services/freightService"
import { isSpecialGroup } from "../../config/freightConfig"
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
        console.log("[Webhook] Processing message", messageData)

        // Skip if message is from self (the bot itself)
        // if (messageData.data?.self === true) {
        //     console.log("[Webhook] Skipping message from self")
        //     res.json({ code: "1000", message: "ok" })
        //     return
        // }

        // Check if message is from a group (chatroom)
        const isGroupMessage = messageData.data?.fromGroup?.includes("@chatroom") || messageData.msgType === "GROUP_TEXT"

        const wId = messageData.data?.wId
        const msgId = String(messageData.data?.msgId)
        const fromWxId = messageData.data?.fromUser
        let nickName = extractNickname(messageData.data?.pushContent) || ""

        // Get bot's actual nickname from users table
        let botActualNickName: string | null = null
        if (wId) {
            const botUser = await User.findOne({ where: { wId } })
            botActualNickName = botUser?.nickName || null
            console.log("[Webhook] Bot actual nickName from DB:", botActualNickName)
        }

        const msgType = messageData.data.messageType
        const isImageMessage =
            msgType === "60002" || msgType === "80002" || messageData.msgType === "PRIVATE_IMAGE" || messageData.msgType === "GROUP_IMAGE"
        const isFileMessage =
            msgType === "60008" ||
            msgType === "60009" ||
            msgType === "80009" ||
            msgType === "80008" ||
            messageData.msgType === "GROUP_FILE" ||
            messageData.msgType === "GROUP_FILE_DONE" ||
            messageData.msgType === "PRIVATE_FILE" ||
            messageData.msgType === "PRIVATE_FILE_DONE"
        let imageUrl: string | null = null
        let fileUrl: string | null = null

        if (isImageMessage) {
            try {
                // Use Eyun API to get image URL
                const eyun = getEyunService()
                const imgResult = await eyun.getMsgImg({
                    wId,
                    msgId: Number(msgId),
                    content: messageData.data.content, // XML content
                    type: 1, // 1 = HD image, 0 = regular image
                })

                if (imgResult.data?.url) {
                    imageUrl = imgResult.data.url
                    console.log(`[Webhook] Image URL: ${imageUrl}`)
                } else {
                    console.log(`[Webhook] getMsgImg returned no URL`)
                }
            } catch (err) {
                console.error("[Webhook] Failed to get image URL:", err)
            }
        }

        if (isFileMessage) {
            try {
                // Use Eyun API to get file URL
                const eyun = getEyunService()
                const fileResult = await eyun.getMsgFile({
                    wId,
                    msgId: Number(msgId),
                    content: messageData.data.content, // XML content
                })

                if (fileResult.data?.url) {
                    fileUrl = fileResult.data.url
                    console.log(`[Webhook] File URL: ${fileUrl}`)
                } else {
                    console.log(`[Webhook] getMsgFile returned no URL`)
                }
            } catch (err) {
                console.error("[Webhook] Failed to get file URL:", err)
            }
        }

        // Get mentioned name from message content

        if (isGroupMessage) {
            const fromGroup = messageData.data.fromGroup

            // Check if this is a group image message
            let content: string
            // For image messages, content is the URL; for text, extract from content

            const mentionedName = extractBotNickName(messageData.data?.content || "", [""])
            const actualContent = extractGroupMessageContent(messageData.data?.content || "", mentionedName || "")
            if (!actualContent.trim()) {
                console.log("[Webhook] Group message has no content")
                res.json({ code: "1000", message: "ok" })
                return
            }
            content = isImageMessage ? imageUrl || "" : isFileMessage ? fileUrl || "" : actualContent

            console.log(fromGroup + " - " + msgId + ": ___________________________________________")
            console.log("content: " + content)

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

            // Check duplicate by msgId
            const existing = await chatHistory.findOne({ where: { msgId } })
            if (existing) {
                console.log(`[Webhook] Message ${msgId} already processed, skipping`)
                res.json({ code: "1000", message: "ok" })
                return
            }

            // Get group name for special group detection
            const groupName = await getGroupName(wId, fromGroup)
            console.log(`[Webhook] Group name: ${groupName}`)

            // Check if this is a special group (运价 group) and process freight
            if (groupName && isSpecialGroup(groupName)) {
                console.log(`[Webhook] This is a special freight group: ${groupName}`)
                await freightService.processFreightMessage({
                    msgId,
                    fromWxId,
                    fromGroup,
                    groupName,
                    content,
                    wId,
                    nickName,
                    timestamp: Date.now(),
                })
                // Continue to also process with AI for bot mention
            }

            await processIncomingGroupMessage({
                msgId,
                fromWxId,
                fromGroup,
                content,
                wId,
                nickName,
                isBotMentioned,
            })

            res.json({ code: "1000", message: "ok" })
            return
        }

        // Get contact info and save user to database
        try {
            const contact = await saveContact(wId, fromWxId)
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

        const content = isImageMessage ? imageUrl || "" : isFileMessage ? fileUrl || "" : messageData.data.content

        await processIncomingMessage({
            fromWxId,
            toWxId: messageData.data.toUser,
            msgId,
            content,
            wId,
            nickName: nickName || "",
        })

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

/**
 * Get group name from group ID using Eyun service
 */
async function getGroupName(wId: string, groupId: string): Promise<string | null> {
    try {
        const eyun = getEyunService()
        const result = await eyun.getChatRoomInfo({ wId, chatRoomId: groupId })
        if (result.data?.topic) {
            return result.data.topic
        }
        return null
    } catch (error) {
        console.error("[Webhook] Failed to get group name:", error)
        return null
    }
}
