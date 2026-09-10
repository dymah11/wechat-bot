import express from "express"
import cors from "cors"
import dotenv from "dotenv"
import routes from "./routes"
import errorHandler from "./middlewares/errorHandler"
import { sequelize } from "./models"
import { initEyunService } from "./services/eyunService"
import { ebPositionService } from "./services/ebPositionService"

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() })
})

app.use("/api", routes)

app.use(errorHandler)

const startServer = async (): Promise<void> => {
    try {
        // Initialize Database
        await sequelize.authenticate()
        console.log("✅ Database connection established successfully.")

        // await sequelize.sync({ alter: true })
        console.log("✅ Database synchronized.")

        // Initialize Eyun Service with base URL (token will be set dynamically on login)
        const eyunBaseUrl = process.env.EYUN_BASE_URL
        if (eyunBaseUrl) {
            initEyunService({ baseUrl: eyunBaseUrl, token: "" })
            console.log("✅ Eyun Service initialized")
        } else {
            console.log("⚠️ Eyun Service not configured (EYUN_BASE_URL required)")
        }

        // Start EB position scheduled notification job
        ebPositionService.startScheduledJob()

        // Start QQ group scheduled notification job (every 3 hours)
        // ebPositionService.startQQScheduledJob()

        app.listen(PORT, () => {
            console.log(`🚀 Server is running on port ${PORT}`)
        })
    } catch (error) {
        console.error("❌ Unable to connect to the database:", error)
        process.exit(1)
    }
}

startServer()

export default app

