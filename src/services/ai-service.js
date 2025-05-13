import { ref, reactive, computed } from 'vue';
import { useStorage } from '@vueuse/core';
import axios from 'axios';
import appConfig from '@/config';

// API Anahtarı ve URL Yapılandırması
const API_SERVICE_CONFIG = {
  gemini: {
    apiKey: appConfig.ai?.gemini?.apiKey || import.meta.env.VITE_GEMINI_API_KEY,
    apiUrl: appConfig.ai?.gemini?.apiUrl || 'https://generativelanguage.googleapis.com/v1beta/models',
    modelName: appConfig.ai?.gemini?.modelName || 'gemini-1.5-pro', // Varsayılan model
  },
  openRouter: {
    apiKey: appConfig.ai?.openRouter?.apiKey || import.meta.env.VITE_OPENROUTER_API_KEY,
    apiUrl: appConfig.ai?.openRouter?.apiUrl || 'https://openrouter.ai/api/v1',
    defaultModels: appConfig.ai?.openRouter?.defaultModels || {
      chat: 'google/gemini-pro-1.5-exp-03-25', // config.js ile senkronize edildi
      instruct: 'google/gemini-flash-1.5',
      technical: 'google/gemini-pro-1.5-exp-03-25', // config.js ile senkronize edildi
    },
    siteUrl: appConfig.ai?.openRouter?.siteUrl,
    appName: appConfig.ai?.openRouter?.appName,
  },
  // Diğer AI servisleri buraya eklenebilir (örn: local LLM)
};

// Aktif AI Servisini Seçme (örn: config dosyasından veya store üzerinden)
const ACTIVE_AI_SERVICE = appConfig.ai?.activeService || 'openRouter'; // config.js'den dinamik olarak al

// --- GENEL API İSTEK FONKSİYONU ---
const makeApiRequest = async (serviceName, endpoint, payload, method = 'POST') => {
  const serviceConfig = API_SERVICE_CONFIG[serviceName];
  if (!serviceConfig || !serviceConfig.apiKey || !serviceConfig.apiUrl) {
    console.warn(`${serviceName} API anahtarı veya URL bulunamadı. Demo mod kullanılıyor.`);
    return simulateAIResponse(payload.contents ? payload.contents[0]?.parts[0]?.text : payload.messages?.[payload.messages.length - 1]?.content);
  }

  const headers = {
    'Authorization': `Bearer ${serviceConfig.apiKey}`,
    'Content-Type': 'application/json',
  };
  
  // OpenRouter için ek başlıklar
  if (serviceName === 'openRouter') {
    if (serviceConfig.siteUrl) headers['HTTP-Referer'] = serviceConfig.siteUrl;
    if (serviceConfig.appName) headers['X-Title'] = serviceConfig.appName;
  }

  try {
    const response = await axios({
      method,
      url: `${serviceConfig.apiUrl}/${endpoint}`,
      data: payload,
      headers,
    });

    // Yanıt formatları servise göre değişebilir, burada genel bir yapı varsayılıyor
    // Gemini-benzeri yanıt
    if (response.data.candidates?.[0]?.content?.parts?.[0]?.text) {
      return {
        text: response.data.candidates[0].content.parts[0].text,
        success: true,
        raw: response.data,
        source: serviceName,
      };
    }
    // OpenAI/OpenRouter-benzeri yanıt (chat completions)
    if (response.data.choices?.[0]?.message?.content) {
      return {
        text: response.data.choices[0].message.content,
        success: true,
        raw: response.data,
        source: serviceName,
      };
    }
    throw new Error('API yanıtından metin alınamadı veya format tanınmıyor');
  } catch (error) {
    console.error(`${serviceName} API hatası:`, error.response?.data || error.message);
    return simulateAIResponse(payload.contents ? payload.contents[0]?.parts[0]?.text : payload.messages?.[payload.messages.length - 1]?.content, serviceName, error.response?.data || error.message);
  }
};

// --- GEMINI ÖZEL FONKSİYONLARI ---
const geminiGenerateContent = async (prompt, options = {}) => {
  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? config.ai?.geminiGenerationConfig?.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? config.ai?.geminiGenerationConfig?.maxOutputTokens ?? 2048,
      topP: options.topP ?? config.ai?.geminiGenerationConfig?.topP ?? 0.8,
      topK: options.topK ?? config.ai?.geminiGenerationConfig?.topK ?? 40,
    },
    safetySettings: config.ai?.geminiSafetySettings || [
      // Varsayılan güvenlik ayarları
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };
  return makeApiRequest('gemini', `${API_SERVICE_CONFIG.gemini.modelName}:generateContent`, payload);
};

const geminiChat = async (messages, options = {}) => {
  const formattedMessages = messages.map(msg => ({
    role: msg.role === 'assistant' ? 'model' : 'user', // system rolü Gemini için user olarak maplenir
    parts: [{ text: msg.content }],
  }));

  const payload = {
    contents: formattedMessages,
    generationConfig: {
      temperature: options.temperature ?? config.ai?.geminiGenerationConfig?.temperature ?? 0.7,
      maxOutputTokens: options.maxTokens ?? config.ai?.geminiGenerationConfig?.maxOutputTokens ?? 2048,
      topP: options.topP ?? config.ai?.geminiGenerationConfig?.topP ?? 0.8,
      topK: options.topK ?? config.ai?.geminiGenerationConfig?.topK ?? 40,
    },
    safetySettings: config.ai?.geminiSafetySettings, // Yukarıdakiyle aynı
  };
  return makeApiRequest('gemini', `${API_SERVICE_CONFIG.gemini.modelName}:generateContent`, payload);
};

// --- OPENROUTER ÖZEL FONKSİYONLARI ---
const openRouterChatCompletion = async (messages, options = {}) => {
  const model = options.model || API_SERVICE_CONFIG.openRouter.defaultModels.chat;
  // Sağlanan koddaki gibi image_url desteği için mesaj formatını kontrol et ve ayarla
  const formattedMessages = messages.map(msg => {
    if (msg.content && typeof msg.content === 'string' && msg.image_url) {
      // Eğer image_url varsa, content'i bir array içine alıp image_url objesini ekle
      return {
        role: msg.role,
        content: [
          {
            type: "text",
            text: msg.content
          },
          {
            type: "image_url",
            image_url: { url: msg.image_url }
          }
        ]
      };
    }
    return { role: msg.role, content: msg.content };
  });

  const payload = {
    model: model,
    messages: formattedMessages, // Güncellenmiş mesajları kullan
    temperature: options.temperature ?? appConfig.ai?.openRouter?.temperature ?? 0.7, // config.js'den temperature al
    max_tokens: options.maxTokens ?? appConfig.ai?.openRouter?.maxTokens ?? 2048,
    top_p: options.topP ?? appConfig.ai?.openRouter?.topP ?? 0.8,
    // OpenRouter'a özel diğer parametreler eklenebilir (örn: stream, top_k vb.)
  };
  return makeApiRequest('openRouter', 'chat/completions', payload);
};

// --- DEMO MODU İÇİN YANIT SİMÜLASYONU ---
const simulateAIResponse = async (prompt, service = 'Demo AI', errorInfo = null) => {
  console.log(`Demo mod (${service}): AI yanıtı simüle ediliyor. Hata: ${errorInfo ? JSON.stringify(errorInfo) : 'Yok'}`);
  await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));
  
  let responseText = `Üzgünüm, \"${prompt?.substring(0, 50)}...\" ile ilgili isteğinizi işlerken bir sorun oluştu. Lütfen daha sonra tekrar deneyin.`;
  if (errorInfo) {
    responseText = `API bağlantı sorunu (${service}): ${JSON.stringify(errorInfo)}. Geliştirici konsolunu kontrol edin. Demo yanıt üretiliyor.`;
  }

  if (prompt) {
    const p = prompt.toLowerCase();
    if (p.includes('üretim') || p.includes('imalat')) {
      responseText = 'Demo: Üretim planı %95 tamamlanma oranına sahip. Kalan işler için tahmini süre 2 gün.';
    } else if (p.includes('stok') || p.includes('malzeme')) {
      responseText = 'Demo: Kritik stok seviyesindeki malzemeler: Röle X (10 adet kaldı), Kablo Y (25m kaldı). Siparişleri verildi.';
    } else if (p.includes('sipariş') || p.includes('satış')) {
      responseText = 'Demo: Son 24 saatte 5 yeni sipariş alındı. En büyük sipariş ABC firmasından (15 hücre).';
    } else if (p.includes('merhaba') || p.includes('selam')) {
      responseText = 'Demo: Merhaba! Size nasıl yardımcı olabilirim?';
    } else {
      responseText = `Demo: \"${prompt.substring(0, 60)}...\" sorgunuz için genel bir demo yanıtı üretildi. Gerçek veri için lütfen API bağlantısını kontrol edin.`;
    }
  }

  return {
    text: responseText,
    success: false, // Demo olduğu için success false olabilir veya ayrı bir flag eklenebilir
    source: service, // Hangi servisin demo yanıtı olduğu belirtilir
    isDemo: true,
  };
};

// --- DIŞA AKTARILAN SERVİS FONKSİYONLARI ---
export const aiService = {
  sendMessage: async (messageContent, conversationHistory = [], options = {}) => {
    let currentMessage;
    // messageContent bir string ise (sadece metin)
    if (typeof messageContent === 'string') {
      currentMessage = { role: 'user', content: messageContent };
    }
    // messageContent bir obje ise (metin ve potansiyel image_url içerebilir)
    else if (typeof messageContent === 'object' && messageContent.text) {
      currentMessage = { 
        role: 'user', 
        content: messageContent.text, 
        ...(messageContent.image_url && { image_url: messageContent.image_url }) 
      };
    } else {
      console.error('Invalid messageContent format:', messageContent);
      return simulateAIResponse("Geçersiz mesaj formatı", ACTIVE_AI_SERVICE);
    }

    let messages = [];

    if (conversationHistory && conversationHistory.length > 0) {
      messages = [...conversationHistory, currentMessage];
    } else {
      messages.push({
        role: 'system',
        content: appConfig.ai?.systemPrompt || 'Sen MehmetEndustriyelTakip uygulaması için bir asistansın. Üretim, stok, siparişler ve genel fabrika süreçleri hakkında bilgi verebilirsin. Sorulara net, kısa ve profesyonel cevaplar ver.'
      });
      messages.push(currentMessage);
    }
    
    // Aktif servise göre isteği yönlendir
    if (ACTIVE_AI_SERVICE === 'gemini') {
      // Gemini için, eğer sadece tek bir prompt varsa generateContent, yoksa chat kullanılabilir.
      // Şimdilik tutarlılık için hep chat (yani generateContent altında contents array) kullanalım.
      return geminiChat(messages, options);
    } else if (ACTIVE_AI_SERVICE === 'openRouter') {
      return openRouterChatCompletion(messages, options);
    } else {
      // Desteklenmeyen servis veya demo modu
      console.warn(`Aktif AI servisi (${ACTIVE_AI_SERVICE}) desteklenmiyor veya yapılandırılmamış. Demo yanıtı kullanılıyor.`);
      return simulateAIResponse(currentMessage.content, ACTIVE_AI_SERVICE);
    }
  },

  // Tek seferlik sorgular için (sohbet geçmişi olmadan)
  ask: async (prompt, options = {}) => {
    if (ACTIVE_AI_SERVICE === 'gemini') {
      return geminiGenerateContent(prompt, options);
    } else if (ACTIVE_AI_SERVICE === 'openRouter') {
      // OpenRouter için tek seferlik sorgu da chat/completions ile yapılabilir,
      // sadece messages array'i tek bir kullanıcı mesajı içerir.
      const messages = [
        { role: 'system', content: appConfig.ai?.systemPrompt || 'Kısa ve öz cevaplar ver.' }, // Daha genel bir sistem mesajı
        { role: 'user', content: prompt }
      ];
      return openRouterChatCompletion(messages, { ...options, model: options.model || API_SERVICE_CONFIG.openRouter.defaultModels.instruct });
    } else {
      return simulateAIResponse(prompt, ACTIVE_AI_SERVICE);
    }
  },
  
  // Yapılandırmayı ve durumu kontrol etmek için yardımcı fonksiyon
  getServiceStatus: () => {
    return {
      activeService: ACTIVE_AI_SERVICE,
      isGeminiConfigured: !!(API_SERVICE_CONFIG.gemini.apiKey && API_SERVICE_CONFIG.gemini.apiUrl),
      isOpenRouterConfigured: !!(API_SERVICE_CONFIG.openRouter.apiKey && API_SERVICE_CONFIG.openRouter.apiUrl),
      geminiModel: API_SERVICE_CONFIG.gemini.modelName,
      openRouterChatModel: API_SERVICE_CONFIG.openRouter.defaultModels.chat,
      openRouterInstructModel: API_SERVICE_CONFIG.openRouter.defaultModels.instruct,
    };
  }
};

// Composable function to use aiService
export function useAiService() {
  return {
    sendMessage: aiService.sendMessage,
    ask: aiService.ask,
    getServiceStatus: aiService.getServiceStatus,
  };
}