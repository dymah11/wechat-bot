import axios from "axios"
import cron from "node-cron"
import * as XLSX from "xlsx"
import FormData from "form-data"
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
const CHATROOM_ID = "58793199436@chatroom"
const W_ID = "bd3406e4-ecf4-4114-82de-b12ecffa82ef"

// QQ Group file sending API (dadaex)
const QQ_GROUP_ID = "935191619"
const DADAEX_TOKEN = "fanyuan123"
const DADAEX_FILE_SEND_URL = "https://www.dadaex.cn/api/wx/sendWildRobotGroupFile"

class EbPositionService {
    private isRunning = false
    private previousPositions: EBreachPosition[] = []
    private lastQQSendTime: number = 0

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

        let message = `🚢 EB系统舱位情况 [${dateStr}]\n`
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

        // Group positions by destination port (目的港码头), then sort by ETD within each group
        const grouped = positions.reduce((acc, pos) => {
            const port = pos.目的港码头 || "未知"
            if (!acc[port]) acc[port] = []
            acc[port].push(pos)
            return acc
        }, {} as Record<string, EBreachPosition[]>)

        // Sort each port group by ETD (earliest first), then flatten
        const sortedPositions = Object.values(grouped)
            .map(group => group.sort((a, b) => new Date(b.船期ETD).getTime() - new Date(a.船期ETD).getTime()))
            .flat()

        const worksheet = XLSX.utils.json_to_sheet(sortedPositions)
        XLSX.utils.book_append_sheet(workbook, worksheet, "舱位情况")

        // Auto-fit column widths based on content
        const cols = Object.keys(sortedPositions[0] || {})
        const sheetCols: { wch: number }[] = cols.map(key => {
            const maxLen = Math.max(
                key.length, // header length
                ...sortedPositions.map(row => String(row[key as keyof EBreachPosition] || "").length)
            )
            return { wch: Math.min(maxLen + 4, 80) } // max 80, add padding
        })
        worksheet['!cols'] = sheetCols

        // Generate file name with timestamp
        const now = new Date()
        const timestamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`
        const fileName = `EB系统舱位情况_${timestamp}.xlsx`
        const tmpDir = path.join(process.cwd(), "tmp")
        const filePath = path.join(tmpDir, fileName)

        // Ensure tmp directory exists
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true })
        }

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
     * Send Excel file to QQ group via dadaex API
     * API: POST https://www.dadaex.cn/api/wx/sendWildRobotGroupFile (form data)
     */
    async sendExcelToQQGroup(filePath: string): Promise<boolean> {
        if (!fs.existsSync(filePath)) {
            console.error("[EB] Excel file not found:", filePath)
            return false
        }

        try {
            const fileName = path.basename(filePath)

            // Use form-data package for proper file upload
            const formData = new FormData()
            formData.append("groupId", QQ_GROUP_ID)
            formData.append("originalname", fileName)
            formData.append("token", DADAEX_TOKEN)
            formData.append("file", fs.createReadStream(filePath))

            const result = await axios.post(
                DADAEX_FILE_SEND_URL,
                formData,
                {
                    // form-data会自动设置正确的Content-Type，不需要手动设置
                    timeout: 60000,
                }
            )

            console.log("[EB] QQ group file send response:", result.data)

            if (result.data?.retcode === 0 || result.data?.status === "ok") {
                console.log("[EB] Excel file sent to QQ group successfully")
                return true
            } else {
                console.error("[EB] Failed to send Excel file to QQ group:", result.data?.message || result.data)
                return false
            }
        } catch (error) {
            console.error("[EB] Error sending Excel file to QQ group:", error)
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

            if (result.code === "1000") {
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
                // await this.sendToGroup(message)
                await this.sendToOpenClaw(message)

                // Generate and send Excel file
                const excelPath = await this.generateExcel(positions)
                await this.sendExcelToGroup(excelPath)
                await this.sendExcelToQQGroup(excelPath)
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
        // cron.schedule("*/5 * * * *", () => {
            console.log("[EB] Cron triggered: running notification job")
            this.runNotificationJob()
        }, {
            timezone: "Asia/Shanghai"
        })

        console.log("[EB] Scheduled job configured for 9:00 and 15:00 daily")
    }

    /**
     * Check if positions have changed compared to previous check
     */
    private hasPositionsChanged(currentPositions: EBreachPosition[]): boolean {
        if (this.previousPositions.length !== currentPositions.length) {
            return true
        }

        // Compare by key fields: 船公司, 船名/航次, 目的港码头, 剩余仓位/总仓位(TEU)
        const currentKeys = currentPositions.map(p =>
            `${p.船公司}|${p["船名/航次"]}|${p.目的港码头}|${p["剩余仓位/总仓位(TEU)"]}`
        ).sort()

        const previousKeys = this.previousPositions.map(p =>
            `${p.船公司}|${p["船名/航次"]}|${p.目的港码头}|${p["剩余仓位/总仓位(TEU)"]}`
        ).sort()

        return JSON.stringify(currentKeys) !== JSON.stringify(previousKeys)
    }

    /**
     * Run QQ group notification job
     * - If positions changed -> send immediately
     * - If no change -> still send every 3 hours (scheduled check)
     */
    async runQQNotificationJob(): Promise<void> {
        if (this.isRunning) {
            console.log("[EB] QQ job already running, skipping...")
            return
        }

        this.isRunning = true
        console.log("[EB] Starting QQ group notification job...")

        try {
            const positions = await this.fetchPositions()

            if (positions.length === 0) {
                console.log("[EB] No positions to send to QQ group")
                this.isRunning = false
                return
            }

            const hasChanged = this.hasPositionsChanged(positions)
            const now = Date.now()
            const threeHours = 3 * 60 * 60 * 1000
            const timeSinceLastSend = now - this.lastQQSendTime

            // Send if: changed OR (3 hours passed since last send AND has positions)
            if (!hasChanged && (this.lastQQSendTime === 0 || timeSinceLastSend < threeHours)) {
                console.log("[EB] Positions unchanged and not time for scheduled send, skipping")
                this.isRunning = false
                return
            }

            // Check rate limit - at least 1 minute between sends (except for changes)
            if (!hasChanged && timeSinceLastSend < 60000) {
                console.log("[EB] QQ rate limited, skipping...")
                this.isRunning = false
                return
            }

            // Generate and send Excel file to QQ group
            const excelPath = await this.generateExcel(positions)
            const sent = await this.sendExcelToQQGroup(excelPath)

            // Delete file after sending
            try {
                if (fs.existsSync(excelPath)) {
                    fs.unlinkSync(excelPath)
                    console.log(`[EB] Deleted temp file: ${excelPath}`)
                }
            } catch (err) {
                console.error("[EB] Failed to delete temp file:", err)
            }

            if (sent) {
                this.previousPositions = [...positions]
                this.lastQQSendTime = now
                console.log("[EB] QQ group notification sent successfully")
            }
        } catch (error) {
            console.error("[EB] QQ job failed:", error)
        } finally {
            this.isRunning = false
        }
    }

    /**
     * Start QQ group scheduled cron job
     * Runs every 10 minutes between 9:00-18:00
     * Sends immediately if positions changed, otherwise at scheduled times
     */
    startQQScheduledJob(): void {
        console.log("[EB] Starting QQ group scheduled job...")

        // Cron: */10 * * * * = every 10 minutes to check for changes
        // Will send immediately if changed, or at scheduled times (9h,12h,15h,18h)
        cron.schedule("*/10 9-18 * * *", () => {
            console.log("[EB] QQ Cron triggered: running notification job")
            this.runQQNotificationJob()
        }, {
            timezone: "Asia/Shanghai"
        })

        console.log("[EB] QQ Scheduled job configured for every 3 hours")
    }
}

// Singleton instance
const ebPositionService = new EbPositionService()

export { ebPositionService, EbPositionService }
