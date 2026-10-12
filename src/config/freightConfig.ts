/**
 * Cấu hình cho tính năng nhận diện nhóm đặc biệt và phân tích giá cước (运价)
 */

// Các ký hiệu đặc biệt trong tên nhóm để nhận diện nhóm运价
// Nếu tên nhóm chứa BẤT KỲ ký hiệu nào trong danh sách này → nhóm đó là nhóm đặc biệt
export const SPECIAL_GROUP_SYMBOLS = [
    "🚢",    // Emoji tàu
    "【运价】",  // Dấu ngoặc vuông Trung Quốc
    "#运价#",   // Dấu thăng
    "【运费】",  // Giá cước vận tải
    "📦",    // Emoji kiện hàng
    "[运价]",  // Dấu ngoặc vuông tiếng Anh
    "💰",    // Emoji tiền
]

// Các từ khóa giá cước trong tin nhắn
// Nếu tin nhắn chứa đủ số từ khóa (theo threshold) → coi là tin giá cước
export const FREIGHT_KEYWORDS = {
    // Từ khóa bắt buộc (ít nhất 1)
    required: [
        "ETD",        // Ngày khởi hành dự kiến
        "ETA",        // Ngày đến dự kiến
        "TEU",        // Đơn vị container 20ft
        "舱位",       // Khoang chứa
        "海运费",     // Cước vận chuyển biển
        "运价",       // Giá cước
        "运费",       // Cước vận tải
        "船公司",     // Hãng tàu
        "目的港",     // Cảng đích
        "起运港",     // Cảng khởi hành
        "码头",       // Bến cảng
        "航次",       // Chuyến tàu
        "仓位",       // Vị trí khoang
        "开船日期",   // Ngày khởi hành
        "SO",         // Shipping Order
        "订舱",       // Đặt khoang
        "放舱",       // Xếp khoang
        "提箱",       // Nhận container
        "还箱",       // Trả container
        "重箱",       // Container nặng
        "空箱",       // Container rỗng
    ],
    // Từ khóa bổ sung (để tăng độ chính xác)
    optional: [
        "USD",        // Đô la Mỹ
        "RMB",        // Nhân dân tệ
        "人民币",     // Nhân dân tệ (Trung Quốc)
        "报价",       // Báo giá
        "价格",       // Giá
        "特价",       // Giá đặc biệt
        "促销",       // Khuyến mãi
        "涨价",       // Tăng giá
        "爆仓",       // Hết khoang
        "缺柜",       // Thiếu container
        "甩柜",       // Hủy khoang
        "截关",       // Đóng container
        "截港",       // Đóng cảng
        "放行",       // Thông quan
        "清关",       // Hải quan
        "单票",       // Từng lô hàng
        "整柜",       // FCL
        "拼箱",       // LCL
        "20GP",       // Container 20 feet
        "40GP",       // Container 40 feet
        "40HQ",       // Container 40 HC
        "45HQ",       // Container 45 HC
    ],
}

// Số từ khóa optional tối thiểu để xác nhận là giá cước
export const FREIGHT_KEYWORD_THRESHOLD = {
    required: 1,  // Cần ít nhất 1 từ khóa bắt buộc
    optional: 2,  // Cần ít nhất 2 từ khóa bổ sung
}

// API endpoint để gửi thông tin giá cước (ví dụ)
export const FREIGHT_API_CONFIG = {
    // URL API để gửi giá cước
    url: "https://www.dadaex.cn/api/vn/freight/upload",
    // Token xác thực
    token: "fanyuan123",
    // Timeout request (ms)
    timeout: 30000,
}

// Group cố định để test - nếu set thì tin nhắn từ group này sẽ luôn được xử lý
export const TEST_FREIGHT_GROUP_ID = "58793199436@chatroom"  // Thay bằng group ID thực tế của bạn

/**
 * Kiểm tra xem tên nhóm có chứa ký hiệu đặc biệt không
 * @param groupName - Tên nhóm WeChat
 * @returns true nếu là nhóm đặc biệt
 */
export function isSpecialGroup(groupName: string): boolean {
    if (!groupName) return false
    return SPECIAL_GROUP_SYMBOLS.some(symbol => groupName.includes(symbol))
}

/**
 * Kiểm tra xem nội dung có phải là giá cước không
 * @param content - Nội dung tin nhắn
 * @returns true nếu có vẻ là giá cước
 */
export function isFreightContent(content: string): boolean {
    if (!content) return false

    const upperContent = content.toUpperCase()
    const normalContent = content.toLowerCase()

    // Đếm số từ khóa bắt buộc
    let requiredCount = 0
    for (const keyword of FREIGHT_KEYWORDS.required) {
        if (normalContent.includes(keyword.toLowerCase()) || upperContent.includes(keyword.toUpperCase())) {
            requiredCount++
        }
    }

    // Đếm số từ khóa bổ sung
    let optionalCount = 0
    for (const keyword of FREIGHT_KEYWORDS.optional) {
        if (normalContent.includes(keyword.toLowerCase()) || upperContent.includes(keyword.toUpperCase())) {
            optionalCount++
        }
    }

    // Cần đủ cả 2 điều kiện
    return requiredCount >= FREIGHT_KEYWORD_THRESHOLD.required && optionalCount >= FREIGHT_KEYWORD_THRESHOLD.optional
}
