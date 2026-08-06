import axios from 'axios';
import { prisma } from '../../common/database/prisma';
import { logger } from '../../common/utils/logger';

export interface CampaignAiConfig {
  originalContent: string;
  productName?: string | null;
  brandName?: string | null;
  productPrice?: string | null;
  discountPrice?: string | null;
  sku?: string | null;
  mandatoryKeywords?: string[];
  bannedKeywords?: string[];
  tone?: string | null;
  lengthConfig?: string | null;
  allowEmoji?: boolean;
  allowHashtag?: boolean;
  ctaRequired?: string | null;
  postCount: number;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export class AiService {
  /**
   * Generates rewritten post contents according to campaign specs
   */
  public static async generatePosts(config: CampaignAiConfig): Promise<string[]> {
    const promises = Array.from({ length: config.postCount }, async (_, i) => {
      let content = '';
      let isValid = false;
      let attempts = 0;

      while (!isValid && attempts < 2) {
        attempts++;
        content = await this.callAiEngine(config, i + 1, attempts);
        const val = this.validateContent(content, config);
        isValid = val.isValid;
      }

      if (!isValid) {
        content = this.generateFallbackContent(config, i + 1);
      }

      return content.trim();
    });

    return Promise.all(promises);
  }

  /**
   * Validates generated post content against rules
   */
  public static validateContent(content: string, config: CampaignAiConfig): ValidationResult {
    const errors: string[] = [];

    // 1. Mandatory keywords check
    if (config.mandatoryKeywords && config.mandatoryKeywords.length > 0) {
      for (const kw of config.mandatoryKeywords) {
        if (kw && !content.toLowerCase().includes(kw.toLowerCase())) {
          errors.push(`Thiếu từ khóa bắt buộc: "${kw}"`);
        }
      }
    }

    // 2. Banned keywords check
    if (config.bannedKeywords && config.bannedKeywords.length > 0) {
      for (const kw of config.bannedKeywords) {
        if (kw && content.toLowerCase().includes(kw.toLowerCase())) {
          errors.push(`Chứa từ khóa bị cấm: "${kw}"`);
        }
      }
    }

    // 3. Product name check
    if (config.productName && !content.toLowerCase().includes(config.productName.toLowerCase())) {
      errors.push(`Thiếu tên sản phẩm: "${config.productName}"`);
    }

    // 4. Brand name check
    if (config.brandName && !content.toLowerCase().includes(config.brandName.toLowerCase())) {
      errors.push(`Thiếu tên thương hiệu: "${config.brandName}"`);
    }

    // 5. Price check
    if (config.productPrice && !content.includes(config.productPrice)) {
      errors.push(`Thiếu hoặc làm sai giá bán: "${config.productPrice}"`);
    }

    // 6. SKU check
    if (config.sku && !content.includes(config.sku)) {
      errors.push(`Thiếu mã SKU: "${config.sku}"`);
    }

    // 7. CTA check
    if (config.ctaRequired && !content.toLowerCase().includes(config.ctaRequired.toLowerCase())) {
      errors.push(`Thiếu lời kêu gọi hành động (CTA): "${config.ctaRequired}"`);
    }

    return {
      isValid: errors.length === 0,
      errors,
    };
  }

  /**
   * Call AI Provider (9router / Local AI / OpenAI API / Gemini via OpenAI-compatible completion format)
   */
  private static async callAiEngine(config: CampaignAiConfig, postIndex: number, attempt: number): Promise<string> {
    // 1. Try fetching AI config from DB System Settings
    let provider = process.env.AI_PROVIDER || '9router';
    let baseUrl = process.env.AI_API_BASE_URL || 'http://localhost:2000/v1';
    let apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '9router-key-local';
    let model = process.env.AI_MODEL || 'qwen2.5';

    try {
      const dbConfig = await prisma.systemSetting.findUnique({ where: { key: 'ai_config' } });
      if (dbConfig && dbConfig.valueJson) {
        const parsed = typeof dbConfig.valueJson === 'string' ? JSON.parse(dbConfig.valueJson) : dbConfig.valueJson;
        if (parsed.baseUrl) baseUrl = parsed.baseUrl;
        if (parsed.provider) provider = parsed.provider;
        if (parsed.apiKey) apiKey = parsed.apiKey;
        if (parsed.model) model = parsed.model;
      }
    } catch (e) {
      /* ignore db lookup error */
    }

    // 2. Normalize API Endpoint for 9router / OpenAI-compatible API
    const cleanBaseUrl = baseUrl.trim().replace(/\/+$/, '');
    const endpoint = cleanBaseUrl.endsWith('/chat/completions') 
      ? cleanBaseUrl 
      : `${cleanBaseUrl}/chat/completions`;

    logger.info(`[AI Service] Calling AI Provider (${provider}) via ${endpoint} [Model: "${model}"] for post #${postIndex}...`);

    try {
      const response = await axios.post(
        endpoint,
        {
          model,
          messages: [
            {
              role: 'system',
              content: `Bạn là chuyên gia sáng tạo nội dung Facebook Marketing đỉnh cao. Hãy sáng tạo lại nội dung sau cho bài viết thứ ${postIndex}/${config.postCount}.
Bắt buộc tuân thủ tuyệt đối:
- Tên sản phẩm: "${config.productName || 'Giữ nguyên'}"
- Thương hiệu: "${config.brandName || 'Giữ nguyên'}"
- Giá niêm yết: "${config.productPrice || 'Giữ nguyên'}"
- Mã SKU: "${config.sku || 'Giữ nguyên'}"
- Từ khóa bắt buộc xuất hiện trong bài: ${(config.mandatoryKeywords || []).join(', ') || 'Không'}
- Từ khóa TUYỆT ĐỐI CẤM xuất hiện: ${(config.bannedKeywords || []).join(', ') || 'Không'}
- Kêu gọi hành động (CTA): "${config.ctaRequired || 'Đặt mua ngay hôm nay'}"
- Giọng văn: ${config.tone || 'Hấp dẫn, tự nhiên, thuyết phục'}
- Emoji: ${config.allowEmoji !== false ? 'Có sử dụng sinh động' : 'Không dùng'}
- Hashtag: ${config.allowHashtag !== false ? 'Có tạo 3-5 hashtag ở cuối bài' : 'Không dùng'}
- CHỈ TRẢ VỀ NỘI DUNG BÀI VIẾT FACEBOOK. KHÔNG TRẢ VỀ LỜI CHÀO, LỜI GIẢI THÍCH HAY BẤT KỲ VĂN BẢN PHỤ NÀO.`,
            },
            { role: 'user', content: config.originalContent },
          ],
          temperature: 0.7 + (attempt - 1) * 0.1,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          timeout: 3000,
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        logger.info(`[AI Service] Successfully generated content using 9router / AI (${provider})!`);
        return text.trim();
      }
    } catch (err: any) {
      logger.warn(`[AI Service] Cannot connect to 9router/AI API (${endpoint}): ${err.message || err}. Falling back to structured generator...`);
    }

    // High quality rule-based copy generator when 9router local server is unreachable
    return this.generateFallbackContent(config, postIndex);
  }

  private static generateFallbackContent(config: CampaignAiConfig, postIndex: number): string {
    const hooks = [
      `🔥 SIÊU PHẨM KHÔNG THỂ BỎ LỠ #` + postIndex,
      `✨ ƯU ĐÃI ĐẶC BIỆT DÀNH CHO BẠN #` + postIndex,
      `🌟 KHÁM PHÁ NGAY SẢN PHẨM MỚI NHẤT #` + postIndex,
      `💥 SỞ HỮU NGAY HÔM NAY VỚI GIÁ CỰC TỐT #` + postIndex,
      `📌 BẠN ĐÃ ĐẦU TƯ ĐÚNG CÁCH CHƯA? #` + postIndex,
    ];

    const hook = hooks[(postIndex - 1) % hooks.length];
    const emojiStr = config.allowEmoji !== false ? '🛒 ⚡ 💖 🎁 🚀' : '';

    let content = `${hook} ${emojiStr}\n\n${config.originalContent}\n\n`;

    if (config.productName) content += `📦 Sản phẩm: ${config.productName}\n`;
    if (config.brandName) content += `🏷️ Thương hiệu: ${config.brandName}\n`;
    if (config.productPrice) content += `💰 Giá niêm yết: ${config.productPrice}\n`;
    if (config.discountPrice) content += `🔥 Giá ưu đãi: ${config.discountPrice}\n`;
    if (config.sku) content += `🔑 Mã SKU: ${config.sku}\n`;

    if (config.mandatoryKeywords && config.mandatoryKeywords.length > 0) {
      content += `✨ Điểm nổi bật: ${config.mandatoryKeywords.join(' • ')}\n`;
    }

    if (config.ctaRequired) {
      content += `\n👉 ${config.ctaRequired}\n`;
    } else {
      content += `\n👉 Đặt hàng ngay hôm nay để nhận ưu đãi hấp dẫn!\n`;
    }

    if (config.allowHashtag !== false) {
      const brandTag = config.brandName ? `#${config.brandName.replace(/\s+/g, '')}` : '#UmBoMilk';
      const prodTag = config.productName ? `#${config.productName.replace(/\s+/g, '')}` : '#AutoPost';
      content += `\n${brandTag} ${prodTag} #MarketingAutomation #FacebookPost`;
    }

    return content;
  }
}
