import axios from "axios"
import cron from "node-cron"
import { getEyunService } from "./eyunService"
import { getOpenClawService } from "./openclawService"

// EB Position API Response Type
interface EBreachPosition {
    船公司: string
    船期ETD: string
    晚开日期: string
    "剩余仓位/总仓位(TEU)": string
    "船名/航次": string
    目的港码头: string
    挂靠港: string
    起运港码头: string
    航线代码: string
    航线: string
    备注: string
    创建时间: string
}

interface EBApiResponse {
    success: boolean
    message: string
    data: EBreachPosition[]
}

// Environment configuration
const EB_API_URL = "https://www.dadaex.cn/api/vn/position/getPositionsData"
const CHATROOM_ID = "26449226599@chatroom"
const W_ID = "bd3406e4-ecf4-4114-82de-b12ecffa82ef"

class EbPositionService {
    private isRunning = false

    /**
     * Fetch EB position data from API
     */
    async fetchPositions(): Promise<EBreachPosition[]> {
        try {
            const response = await axios.get<EBApiResponse>(EB_API_URL, {
                timeout: 30000,
                headers: {
                    "Content-Type": "application/json",
                },
            })

            if (response.data.success && Array.isArray(response.data.data)) {
                console.log(`[EB] Fetched ${response.data.data.length} positions`)
                return response.data.data
            } else {
                console.error("[EB] API returned unsuccessful response:", response.data.message)
                return []
            }
        } catch (error) {
            console.error("[EB] Failed to fetch positions:", error)
            return []
        }
    }

    /**
     * Format position data for WeChat message
     */
    formatPositionMessage(positions: EBreachPosition[]): string {
        if (!positions || positions.length === 0) {
            return "📭 当前没有舱位数据"
        }

        const now = new Date()
        const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`

        let message = `🚢 EB系统舱位情况 [${dateStr}]\n`
        message += `━━━━━━━━━━━━━━━━━━━━\n\n`

        // Group by shipping company
        const byCompany = new Map<string, EBreachPosition[]>()
        for (const pos of positions) {
            const company = pos.船公司
            if (!byCompany.has(company)) {
                byCompany.set(company, [])
            }
            byCompany.get(company)!.push(pos)
        }

        // Format each company's positions
        for (const [company, companyPositions] of byCompany) {
            message += `🏢 ${company}\n`

            for (const pos of companyPositions) {
                // Parse remaining/total slots
                const slots = pos["剩余仓位/总仓位(TEU)"]
                const [remaining, total] = slots.split("/").map(Number)
                const hasAvailability = remaining > 0

                // Status emoji
                const statusEmoji = hasAvailability ? "✅" : "❌"
                const slotsEmoji = hasAvailability ? "📦" : "🔴"

                // ETD date
                const etdDate = new Date(pos.船期ETD)
                const etdStr = `${etdDate.getMonth() + 1}/${etdDate.getDate()}`

                // Late opening date
                const lateDate = new Date(pos.晚开日期)
                const lateStr = `${lateDate.getMonth() + 1}/${lateDate.getDate()}`

                message += `${statusEmoji} ${pos["船名/航次"]}\n`
                message += `   ${slotsEmoji} 仓位: ${slots} TEU\n`
                message += `   📍 目的港: ${pos.目的港码头}\n`
                message += `   📅 ETD: ${etdStr} | 晚开: ${lateStr}\n`
                message += `   🚢 起运港: ${pos.起运港码头 || "-"}\n`

                if (pos.挂靠港) {
                    message += `   🔄 挂靠港: ${pos.挂靠港}\n`
                }

                message += "\n"
            }
        }

        message += `━━━━━━━━━━━━━━━━━━━━\n`
        message += `📊 共 ${positions.length} 条船期数据`

        return message
    }

    /**
     * Send position data to WeChat group
     */
    async sendToGroup(message: string): Promise<boolean> {
        if (!CHATROOM_ID) {
            console.error("[EB] Missing EB_GROUP_ID configuration")
            return false
        }

        try {
            const eyunService = getEyunService()
            const result = await eyunService.sendText({
                wId: W_ID,
                wcId: CHATROOM_ID,
                content: message,
            })

            if (result.code === "80008" || result.code === "80009") {
                console.log("[EB] Message sent successfully to group")
                return true
            } else {
                console.error("[EB] Failed to send message:", result.message)
                return false
            }
        } catch (error) {
            console.error("[EB] Error sending message:", error)
            return false
        }
    }

    /**
     * Send position data to OpenClaw
     */
    async sendToOpenClaw(message: string): Promise<boolean> {
        try {
            const openclawService = getOpenClawService()
            const response = await openclawService.chat(CHATROOM_ID, "eb-system", message)
            console.log("[EB] OpenClaw response:", response)
            return true
        } catch (error) {
            console.error("[EB] Error sending to OpenClaw:", error)
            return false
        }
    }

    /**
     * Main job: fetch and send position data
     */
    async runNotificationJob(): Promise<void> {
        if (this.isRunning) {
            console.log("[EB] Job already running, skipping...")
            return
        }

        this.isRunning = true
        console.log("[EB] Starting scheduled notification job...")

        try {
            const positions = await this.fetchPositions()
            const message = this.formatPositionMessage(positions)

            if (positions.length > 0) {
                await this.sendToGroup(message)
                await this.sendToOpenClaw(message)
            } else {
                console.log("[EB] No positions to send")
            }
        } catch (error) {
            console.error("[EB] Job failed:", error)
        } finally {
            this.isRunning = false
        }
    }

    /**
     * Start the scheduled cron job
     * Runs at 9:00 and 15:00 every day
     */
    startScheduledJob(): void {
        console.log("[EB] Starting EB position scheduled job...")

        // Cron: 0 9,15 * * * = at 9:00 and 15:00 every day
        cron.schedule("0 9,15 * * *", () => {
            console.log("[EB] Cron triggered: running notification job")
            this.runNotificationJob()
        }, {
            timezone: "Asia/Shanghai"
        })

        console.log("[EB] Scheduled job configured for 9:00 and 15:00 daily")
    }
}

// Singleton instance
const ebPositionService = new EbPositionService()

export { ebPositionService, EbPositionService }
