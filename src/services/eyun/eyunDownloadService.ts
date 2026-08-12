import { EyunBaseService } from "./eyunBaseService"
import { EyunResponse, GetMsgFileRequest, GetMsgImgRequest, GetMsgVoiceRequest, GetMsgEmojiRequest, AsyncVideoDownloadRequest, AsyncVideoDownloadResponse } from "../../types/eyun"

/**
 * Download APIs
 * POST /getMsgFile, /getMsgImg, /getMsgVoice, /getMsgEmoji, /asynGetMsgVideo, /getMsgVideoRes
 */
export class EyunDownloadService extends EyunBaseService {
    async getMsgFile(params: GetMsgFileRequest): Promise<EyunResponse<{ content: string }>> {
        return this.request("/getMsgFile", params)
    }

    async getMsgImg(params: GetMsgImgRequest): Promise<EyunResponse<{ url: string }>> {
        return this.request("/getMsgImg", params)
    }

    async getMsgVoice(params: GetMsgVoiceRequest): Promise<EyunResponse<{ content: string }>> {
        return this.request("/getMsgVoice", params)
    }

    async getMsgEmoji(params: GetMsgEmojiRequest): Promise<EyunResponse<{ content: string }>> {
        return this.request("/getMsgEmoji", params)
    }

    async asynGetMsgVideo(params: AsyncVideoDownloadRequest): Promise<EyunResponse<AsyncVideoDownloadResponse>> {
        return this.request("/asynGetMsgVideo", params)
    }

    async getMsgVideoRes(id: string): Promise<EyunResponse<{ content: string }>> {
        return this.request("/getMsgVideoRes", { id })
    }
}
