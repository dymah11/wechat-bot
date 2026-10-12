import axios from "axios"
import { getEyunService } from "./eyunService"
import { FREIGHT_API_CONFIG, isSpecialGroup, isFreightContent, TEST_FREIGHT_GROUP_ID } from "../config/freightConfig"

// EB Freight API Response Type
interface EBFreightResponse {
    success: boolean
    message: string
    data?: {
        id?: string
        status?: string
    }
}

/**
 * Interface cho tin nhắn giá cước
 */
export interface FreightMessage {
    msgId: string
    fromWxId: string       // Người gửi
    fromGroup: string      // ID nhóm
    groupName: string      // Tên nhóm
    content: string        // Nội dung tin nhắn
    wId: string            // ID thiết bị
    nickName: string       // Biệt danh người gửi
    timestamp: number      // Thời gian nhận
}

/**
 * Interface cho kết quả phân tích freight
 */
export interface FreightAnalysisResult {
    isFreight: boolean        // Có phải giá cước không
    confidence: number        // Độ chính xác (0-100)
    matchedKeywords: string[] // Các từ khóa đã tìm thấy
    message: string           // Tin nhắn giá cước
}

class FreightService {
    private isProcessing = false

    /**
     * Phân tích tin nhắn để xác định có phải giá cước không
     */
    async analyzeFreightMessage(message: FreightMessage): Promise<FreightAnalysisResult> {
        const { content, groupName, fromGroup } = message
        const result: FreightAnalysisResult = {
            isFreight: false,
            confidence: 0,
            matchedKeywords: [],
            message: "",
        }

        // Bước 0: Kiểm tra nếu là group test cố định
        const isTestGroup = TEST_FREIGHT_GROUP_ID && fromGroup === TEST_FREIGHT_GROUP_ID
        console.log(`[Freight] Is test group: ${isTestGroup}`)

        // Bước 1: Kiểm tra xem nhóm có phải là nhóm đặc biệt không
        const isSpecial = isSpecialGroup(groupName)
        console.log(`[Freight] Group "${groupName}" is special group: ${isSpecial}`)

        if (!isSpecial && !isTestGroup) {
            console.log(`[Freight] Group does not contain special symbols, skipping`)
            return result
        }

        // Bước 2: Kiểm tra nội dung có phải là giá cước không
        const contentLower = content.toLowerCase()
        const contentUpper = content.toUpperCase()

        // Import keywords vào đây để tránh circular dependency
        const { FREIGHT_KEYWORDS } = await import("../config/freightConfig")

        // Tìm các từ khóa trong nội dung
        const matchedRequired: string[] = []
        const matchedOptional: string[] = []

        for (const keyword of FREIGHT_KEYWORDS.required) {
            if (contentLower.includes(keyword.toLowerCase()) || contentUpper.includes(keyword.toUpperCase())) {
                matchedRequired.push(keyword)
            }
        }

        for (const keyword of FREIGHT_KEYWORDS.optional) {
            if (contentLower.includes(keyword.toLowerCase()) || contentUpper.includes(keyword.toUpperCase())) {
                matchedOptional.push(keyword)
            }
        }

        result.matchedKeywords = [...matchedRequired, ...matchedOptional]

        // Tính confidence dựa trên số từ khóa tìm thấy
        const requiredScore = Math.min(matchedRequired.length / 3, 1) * 50  // Max 50 điểm cho required
        const optionalScore = Math.min(matchedOptional.length / 5, 1) * 50  // Max 50 điểm cho optional
        result.confidence = Math.round(requiredScore + optionalScore)

        // Xác định có phải là giá cước không
        // Cần ít nhất 1 required keyword và confidence >= 50
        result.isFreight = matchedRequired.length >= 1 && result.confidence >= 50

        if (result.isFreight) {
            result.message = this.formatFreightMessage(message, result)
        }

        console.log(`[Freight] Analysis result: isFreight=${result.isFreight}, confidence=${result.confidence}%, matched=${result.matchedKeywords.join(", ")}`)

        return result
    }

    /**
     * Format tin nhắn giá cước để gửi lên EB
     */
    private formatFreightMessage(message: FreightMessage, analysis: FreightAnalysisResult): string {
        return JSON.stringify({
            type: "freight",
            source: "wechat",
            groupId: message.fromGroup,
            groupName: message.groupName,
            senderId: message.fromWxId,
            senderName: message.nickName,
            content: message.content,
            timestamp: new Date(message.timestamp).toISOString(),
            confidence: analysis.confidence,
            matchedKeywords: analysis.matchedKeywords,
        }, null, 2)
    }

    /**
     * Gửi thông tin giá cước lên hệ thống EB
     */
    async uploadFreightToEB(freightData: FreightMessage, analysis: FreightAnalysisResult): Promise<boolean> {
        try {
            console.log(`[Freight] Uploading freight to EB system...`)

            const payload = {
                wId: freightData.wId,
                groupId: freightData.fromGroup,
                groupName: freightData.groupName,
                senderId: freightData.fromWxId,
                senderName: freightData.nickName,
                content: freightData.content,
                timestamp: freightData.timestamp,
                confidence: analysis.confidence,
                matchedKeywords: analysis.matchedKeywords,
            }

            const response = await axios.post<EBFreightResponse>(
                FREIGHT_API_CONFIG.url,
                payload,
                {
                    timeout: FREIGHT_API_CONFIG.timeout,
                    headers: {
                        "Content-Type": "application/json",
                        "Authorization": `Bearer ${FREIGHT_API_CONFIG.token}`,
                    },
                }
            )

            if (response.data.success) {
                console.log(`[Freight] Successfully uploaded freight to EB:`, response.data)
                return true
            } else {
                console.error(`[Freight] EB API returned error:`, response.data.message)
                return false
            }
        } catch (error) {
            console.error(`[Freight] Failed to upload freight to EB:`, error)
            return false
        }
    }

    /**
     * Xử lý tin nhắn từ nhóm đặc biệt
     * Được gọi từ webhook khi có tin nhắn mới
     */
    async processFreightMessage(message: FreightMessage): Promise<void> {
        if (this.isProcessing) {
            console.log(`[Freight] Already processing a message, skipping...`)
            return
        }

        this.isProcessing = true
        console.log(`[Freight] Processing freight message from group: ${message.groupName}`)

        try {
            // Phân tích tin nhắn
            const analysis = await this.analyzeFreightMessage(message)

            if (!analysis.isFreight) {
                console.log(`[Freight] Message is not a freight message, skipping`)
                return
            }

            // Gửi lên EB
            const success = await this.uploadFreightToEB(message, analysis)

            if (success) {
                console.log(`[Freight] Freight message processed and uploaded successfully`)
            } else {
                console.log(`[Freight] Freight message analyzed but upload failed`)
            }
        } catch (error) {
            console.error(`[Freight] Error processing freight message:`, error)
        } finally {
            this.isProcessing = false
        }
    }

    /**
     * Gửi thông báo vào nhóm WeChat
     */
    async sendNotificationToGroup(wId: string, groupId: string, message: string): Promise<boolean> {
        try {
            const eyunService = getEyunService()
            const result = await eyunService.sendText({
                wId,
                wcId: groupId,
                content: message,
            })

            if (result.code === "1000") {
                console.log(`[Freight] Notification sent to group ${groupId}`)
                return true
            } else {
                console.error(`[Freight] Failed to send notification:`, result.message)
                return false
            }
        } catch (error) {
            console.error(`[Freight] Error sending notification:`, error)
            return false
        }
    }
}

// Singleton instance
const freightService = new FreightService()

export { freightService, FreightService }
