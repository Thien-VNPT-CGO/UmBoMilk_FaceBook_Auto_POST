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
              content: `Bạn là chuyên gia Copywriter & Facebook Marketing hàng đầu.
Nhiệm vụ của bạn: Hãy dựa vào nội dung/ý tưởng mẫu được cung cấp để VIẾT LẠI THÀNH MỘT BÀI VIẾT NỘI DUNG HOÀN TOÀN MỚI cho bài thứ ${postIndex}/${config.postCount}.

🔴 NGUYÊN TẮC SÁNG TẠO BẮT BUỘC:
1. KHÔNG ĐƯỢC chép nguyên văn nội dung mẫu rồi chỉ thêm emoji/icon. Bạn phải diễn đạt lại (paraphrase & rewrite) bằng vốn từ sinh động, sáng tạo bài viết mới lạ hoàn toàn nhưng giữ nguyên giá trị cốt lõi.
2. BẮT BUỘC GIỮ NGUYÊN VĂN KHÔNG THAY ĐỔI CÁC DÒNG THÔNG TIN CỐ ĐỊNH NẾU CÓ TRONG BÀI MẪU (như Tiêu đề thương hiệu, Hotline, Link Zalo, Link Bio, Shopee Food, Grab Food,...).
3. Đảm bảo góc nhìn mới mẻ, tự nhiên, đánh trúng tâm lý khách hàng.

Yêu cầu bổ sung:
- Tên sản phẩm: "${config.productName || 'Giữ nguyên nếu có'}"
- Thương hiệu: "${config.brandName || 'Giữ nguyên nếu có'}"
- Giá niêm yết: "${config.productPrice || 'Giữ nguyên nếu có'}"
- Từ khóa bắt buộc xuất hiện trong bài: ${(config.mandatoryKeywords || []).join(', ') || 'Không'}
- Từ khóa TUYỆT ĐỐI CẤM: ${(config.bannedKeywords || []).join(', ') || 'Không'}
- Kêu gọi hành động (CTA): "${config.ctaRequired || 'Đặt hàng ngay hôm nay'}"
- Giọng văn: ${config.tone || 'Hấp dẫn, tự nhiên, thuyết phục'}
- Emoji: ${config.allowEmoji !== false ? 'Sử dụng tự nhiên, sinh động' : 'Không dùng'}
- Hashtag: ${config.allowHashtag !== false ? 'Tạo 3-5 hashtag ở cuối bài' : 'Không dùng'}

⚠️ CHỈ TRẢ VỀ NỘI DUNG BÀI VIẾT FACEBOOK HOÀN CHỈNH. KHÔNG TRẢ VỀ LỜI CHÀO, LỜI GIẢI THÍCH HAY BẤT KỲ VĂN BẢN PHỤ NÀO.`,
            },
            { role: 'user', content: config.originalContent },
          ],
          temperature: 0.75 + (attempt - 1) * 0.1,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          timeout: 45000,
        }
      );

      const text = response.data?.choices?.[0]?.message?.content;
      if (text && text.trim()) {
        logger.info(`[AI Service] Successfully generated content using AI (${provider})!`);
        return text.trim();
      }
    } catch (err: any) {
      logger.warn(`[AI Service] Cannot connect to AI API (${endpoint}): ${err.message || err}. Falling back to structured generator...`);
    }

    // High quality rule-based copy generator when AI endpoint is unreachable
    return this.generateFallbackContent(config, postIndex);
  }

  private static parseContentAndFooter(original: string): { body: string; fixedLines: string[] } {
    if (!original) return { body: '', fixedLines: [] };
    const lines = original.split('\n');
    const bodyLines: string[] = [];
    const fixedLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      const isFixed =
        trimmed.startsWith('Sữa Bò Váng') ||
        trimmed.startsWith('☎️') ||
        trimmed.startsWith('📲') ||
        trimmed.startsWith('📍') ||
        trimmed.startsWith('👉') ||
        trimmed.startsWith('|') ||
        trimmed.toLowerCase().includes('hotline:') ||
        trimmed.toLowerCase().includes('zalo:') ||
        trimmed.toLowerCase().includes('linkbio') ||
        trimmed.toLowerCase().includes('shopee food') ||
        trimmed.toLowerCase().includes('grab food');

      if (isFixed) {
        fixedLines.push(line);
      } else if (trimmed) {
        bodyLines.push(line);
      }
    }

    return {
      body: bodyLines.join('\n').trim(),
      fixedLines
    };
  }

  private static generateFallbackContent(config: CampaignAiConfig, postIndex: number): string {
    const hooks = [
      `🥛 Thưởng thức hương vị nguyên bản thơm ngon chuẩn vị từ thiên nhiên!`,
      `✨ Dinh dưỡng thuần khiết cho cả gia đình mỗi ngày năng lượng!`,
      `🌿 Lựa chọn hoàn hảo cho sức khỏe với dưỡng chất 100% tự nhiên!`,
      `🔥 Siêu phẩm giải khát & bổ dưỡng không thể bỏ qua hôm nay!`,
      `❤️ Trải nghiệm sự khác biệt từ nguồn sữa bò tươi chất lượng nhất!`,
    ];

    const bodyIntros = [
      `Bạn đang tìm kiếm giải pháp dinh dưỡng an lành và tươi ngon cho bản thân và gia đình? Đừng bỏ lỡ dòng sản phẩm độc đáo được chăm chút từ những nguồn nguyên liệu sạch nhất.`,
      `Hương vị béo ngậy, thanh mát tự nhiên sẽ khiến bạn mê đắm ngay từ ngụm đầu tiên. Mỗi sản phẩm là sự kết tụ tinh túy mang lại sự hài lòng tuyệt đối!`,
      `Sự kết hợp hoàn hảo giữa quy trình chuẩn sạch và hương vị tuyệt hảo. Đáp ứng đầy đủ tiêu chuẩn khắt khe nhất để mang lại sự yên tâm tuyệt đối cho người tiêu dùng.`,
      `Chất lượng hảo hạng làm nên thương hiệu được hàng nghìn khách hàng tin dùng mỗi ngày. Hãy thử ngay để cảm nhận vị ngon khác biệt!`,
    ];

    const hook = hooks[(postIndex - 1) % hooks.length];
    const intro = bodyIntros[(postIndex - 1) % bodyIntros.length];
    const parsed = this.parseContentAndFooter(config.originalContent);

    let content = `${hook}\n\n${intro}\n\n`;

    if (parsed.body) {
      content += `${parsed.body}\n\n`;
    }

    // Append mandatory fixed lines (Hotline, Links, Brand taglines) intact
    if (parsed.fixedLines.length > 0) {
      content += `${parsed.fixedLines.join('\n')}\n\n`;
    } else {
      content += `Sữa Bò Váng ỤM BÒ MILK 100% Từ Nông Sản Việt\n| Không Pha Nước, Không Chất Bảo Quản, Không Sữa Bò Thô Đông Lạnh |\n☎️ Hotline: 070.888.0404\n📲 Đặt hàng SIÊU TỐC Zalo: https://zalo.me/3200385858429095661\n📍Danh sách các cửa hàng & Menu tại đây: https://linkbio.co/7082304AilDwM\n👉 “Sữa Bò Váng Ụm Bò Milk” đã có mặt trên các ứng dụng Shopee Food & Grab Food\n\n`;
    }

    if (config.allowHashtag !== false) {
      const brandTag = config.brandName ? `#${config.brandName.replace(/\s+/g, '')}` : '#UmBoMilk';
      content += `${brandTag} #SuaBoVang #UmBoMilk #DinhDuongSach #NongSanViet`;
    }

    return content.trim();
  }
}
