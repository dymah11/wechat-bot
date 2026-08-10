import { Request, Response, NextFunction } from "express"

/**
 * Request logging middleware
 * Format: [127.0.0.1]||[POST]||[/vn/eyun/auth/iPadLogin]
 */
// ANSI green color code
const GREEN = "\x1b[32m"
const RESET = "\x1b[0m"

export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method
    const url = req.originalUrl
    let ip = req.ip || req.socket.remoteAddress || "-"
    // Normalize IPv6 localhost to IPv4
    if (ip === "::1" || ip === "::ffff:127.0.0.1") ip = "127.0.0.1"
    console.log(`${GREEN}[${ip}]||[${method}]||[${url}]${RESET}`)
    next()
}