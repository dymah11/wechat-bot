import axios from "axios"
import cron from "node-cron"
import * as XLSX from "xlsx"
import { getEyunService } from "./eyunService"
import { getOpenClawService } from "./openclawService"
import path from "path"
import fs from "fs"

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
        const dateStr = `${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()} ${now.getHours()}:${String(now.getMinutes()).padStart(2, "0")}`

        // Only show positions with availability
        const available = positions.filter(p => {
            const [remaining] = p["剩余仓位/总仓位(TEU)"].split("/").map(Number)
            return remaining > 0
        })

        let message = `🚢 EB舱位 [${dateStr}]\n`
        message += `━━━━━━━━━━━━━━━━━━━━\n`
        message += `📊 有仓位: ${available.length}/${positions.length} 条\n\n`

        for (const pos of available) {
            const slots = pos["剩余仓位/总仓位(TEU)"]
            const [remaining, total] = slots.split("/")

            // ETD date
            const etdDate = new Date(pos.船期ETD)
            const etdStr = `${etdDate.getMonth() + 1}/${etdDate.getDate()}`

            // Late opening date
            const lateDate = new Date(pos.晚开日期)
            const lateStr = `${lateDate.getMonth() + 1}/${lateDate.getDate()}`

            // Shorten company name
            const company = pos.船公司

            message += `🏢 ${company}\n`
            message += `   🚢 ${pos["船名/航次"]}\n`
            message += `   📦 ${remaining}/${total} TEU | 📍 ${pos.目的港码头}\n`
            message += `   📅 ETD: ${etdStr} | 晚开: ${lateStr}\n`
            message += `   🔖 航线: ${pos.航线代码}\n`
            if (pos.起运港码头) {
                message += `   🚢 起运: ${pos.起运港码头}\n`
            }
            if (pos.挂靠港) {
                message += `   🔄 挂靠: ${pos.挂靠港}\n`
            }
            message += "\n"
        }

        message += `━━━━━━━━━━━━━━━━━━━━`

        return message
    }

    /**
     * Generate Excel file from positions data
     */
    async generateExcel(positions: EBreachPosition[]): Promise<string> {
        const workbook = XLSX.utils.book_new()

        // Only show positions with availability
        const available = positions.filter(p => {
            const [remaining] = p["剩余仓位/总仓位(TEU)"].split("/").map(Number)
            return remaining > 0
        })

        // Prepare data for Excel
        const data = available.map(pos => {
            const slots = pos["剩余仓位/总仓位(TEU)"]
            const [remaining, total] = slots.split("/")
            return {
                "船公司": pos.船公司,
                "船名/航次": pos["船名/航次"],
                "剩余仓位": remaining,
                "总仓位": total,
                "目的港": pos.目的港码头,
                "ETD": pos.船期ETD,
                "晚开日期": pos.晚开日期,
                "起运港": pos.起运港码头,
                "航线代码": pos.航线代码,
                "挂靠港": pos.挂靠港,
            }
        })

        const worksheet = XLSX.utils.json_to_sheet(data)
        XLSX.utils.book_append_sheet(workbook, worksheet, "舱位情况")

        // Generate file name with timestamp
        const now = new Date()
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
        const fileName = `EB舱位_${timestamp}.xlsx`
        const filePath = path.join("/tmp", fileName)

        XLSX.writeFile(workbook, filePath)
        console.log(`[EB] Excel file generated: ${filePath}`)

        return filePath
    }

    /**
     * Send Excel file to WeChat group via base64
     */
    async sendExcelToGroup(filePath: string): Promise<boolean> {
        if (!fs.existsSync(filePath)) {
            console.error("[EB] Excel file not found:", filePath)
            return false
        }

        try {
            const eyunService = getEyunService()
            const fileName = path.basename(filePath)

            // Read file as base64
            const fileBuffer = fs.readFileSync(filePath)
            const base64 = fileBuffer.toString("base64")

            const result = await eyunService.sendFileBase64({
                wId: W_ID,
                wcId: CHATROOM_ID,
                base64: base64,
                fileName: fileName,
            })

            console.log("[EB] Excel file sent to group:", result)

            if (result.code === "1000") {
                console.log("[EB] Excel file sent successfully")
                return true
            } else {
                console.error("[EB] Failed to send Excel file:", result.message)
                return false
            }
        } catch (error) {
            console.error("[EB] Error sending Excel file:", error)
            return false
        }
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
            console.log("[EB] Message sent to group:", result)

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

                // Generate and send Excel file
                const excelPath = await this.generateExcel(positions)
                await this.sendExcelToGroup(excelPath)
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
        // cron.schedule("0 9,15 * * *", () => {
        cron.schedule("*/5 * * * *", () => {
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
