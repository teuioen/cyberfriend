/**
 * 天气系统
 * 使用 wttr.in 免费接口获取天气（无需API Key）
 * 结果缓存到 settings 表，避免频繁请求
 */
import { Database } from '../database/db';
import { logger } from '../utils/logger';

export interface WeatherConfig {
  enabled: boolean;
  city: string;
  fetchIntervalMinutes: number;
}

export interface WeatherData {
  temp: number;
  feelsLike: number;
  humidity: number;
  description: string;
  windSpeed: number;
  fetchedAt: number;
  city: string;
}

export class WeatherSystem {
  private readonly CACHE_KEY = 'weather_cache';

  constructor(
    private db: Database,
    private cfg: WeatherConfig
  ) {}

  /** 获取缓存的天气（不发起网络请求） */
  getWeather(): WeatherData | null {
    const cached = this.db.getSetting(this.CACHE_KEY);
    if (!cached) return null;
    try {
      return JSON.parse(cached) as WeatherData;
    } catch {
      return null;
    }
  }

  /** 获取天气（优先用缓存，过期则重新请求） */
  async fetchWeather(): Promise<WeatherData | null> {
    if (!this.cfg.enabled) return null;

    const cached = this.getWeather();
    const intervalMs = this.cfg.fetchIntervalMinutes * 60 * 1000;
    if (cached && Date.now() - cached.fetchedAt < intervalMs) {
      return cached;
    }

    try {
      const city = encodeURIComponent(this.cfg.city);
      // 尝试 JSON 详细格式（不带 lang=zh 避免 500）
      const url = `https://wttr.in/${city}?format=j1`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'curl/7.68.0' }  // wttr.in 对 curl UA 更友好
      });

      if (!resp.ok) {
        // 降级到简单文本格式
        return await this.fetchSimple();
      }

      const data = await resp.json() as any;
      const current = data.current_condition?.[0];
      if (!current) return await this.fetchSimple();

      const descEn: string = current.weatherDesc?.[0]?.value ?? '';
      const weather: WeatherData = {
        temp: parseInt(current.temp_C, 10),
        feelsLike: parseInt(current.FeelsLikeC, 10),
        humidity: parseInt(current.humidity, 10),
        description: this.translateDesc(descEn),
        windSpeed: parseInt(current.windspeedKmph, 10),
        fetchedAt: Date.now(),
        city: this.cfg.city,
      };

      this.db.setSetting(this.CACHE_KEY, JSON.stringify(weather));
      logger.info(`[Weather] ${this.cfg.city}: ${weather.temp}°C ${weather.description}`);
      return weather;
    } catch (e) {
      logger.warn(`[Weather] 获取天气失败 (${this.cfg.city}): ${e}`);
      return this.getWeather();
    }
  }

  /** 降级方案：使用简单文本格式 */
  private async fetchSimple(): Promise<WeatherData | null> {
    try {
      const city = encodeURIComponent(this.cfg.city);
      // format=j2 返回更简单的JSON
      const url = `https://wttr.in/${city}?format=%t+%C+%h+%w`;
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(8000),
        headers: { 'User-Agent': 'curl/7.68.0' }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = (await resp.text()).trim();
      // 格式: "+25°C Partly cloudy 78% ↙13km/h"
      const tempMatch = text.match(/([+-]?\d+)°C/);
      const temp = tempMatch ? parseInt(tempMatch[1]) : 0;
      const weather: WeatherData = {
        temp, feelsLike: temp, humidity: 0,
        description: text.replace(/[+-]?\d+°C/, '').trim().split(' ').slice(0, 3).join(' ') || '未知',
        windSpeed: 0, fetchedAt: Date.now(), city: this.cfg.city,
      };
      this.db.setSetting(this.CACHE_KEY, JSON.stringify(weather));
      logger.info(`[Weather] 简单格式 ${this.cfg.city}: ${weather.temp}°C`);
      return weather;
    } catch (e) {
      logger.warn(`[Weather] 简单格式也失败: ${e}`);
      return this.getWeather();
    }
  }

  /** 英文天气描述 → 中文 */
  private translateDesc(en: string): string {
    const map: Record<string, string> = {
      'Sunny': '晴天', 'Clear': '晴朗', 'Partly cloudy': '多云', 'Cloudy': '阴天',
      'Overcast': '阴云密布', 'Mist': '薄雾', 'Fog': '浓雾', 'Freezing fog': '冻雾',
      'Patchy rain possible': '局部有雨', 'Patchy snow possible': '局部有雪',
      'Blowing snow': '大风雪', 'Blizzard': '暴风雪', 'Thundery outbreaks possible': '可能有雷暴',
      'Light drizzle': '小毛毛雨', 'Drizzle': '毛毛雨', 'Heavy drizzle': '大毛毛雨',
      'Light rain': '小雨', 'Moderate rain': '中雨', 'Heavy rain': '大雨',
      'Light snow': '小雪', 'Moderate snow': '中雪', 'Heavy snow': '大雪',
      'Light sleet': '小冻雨', 'Moderate sleet': '中冻雨', 'Heavy sleet': '大冻雨',
      'Thunderstorm': '雷暴', 'Patchy light rain with thunder': '雷阵雨',
      'Torrential rain shower': '暴雨', 'Light rain shower': '阵雨',
    };
    for (const [k, v] of Object.entries(map)) {
      if (en.toLowerCase().includes(k.toLowerCase())) return v;
    }
    return en || '未知';
  }

  /** 供 PromptBuilder 使用的单行天气描述 */
  toPromptCompactString(): string {
    const w = this.getWeather();
    if (!w) return '';
    return `${w.city} ${w.description} ${w.temp}°`;
  }

  /** 供 PromptBuilder 使用的单行天气描述 */
  toPromptString(): string {
    const w = this.getWeather();
    if (!w) return '';
    const ageMin = Math.round((Date.now() - w.fetchedAt) / 60000);
    const ageStr = ageMin < 5 ? '刚获取' : `${ageMin}分钟前获取`;
    return `${w.city}: ${w.description} ${w.temp}°C（体感${w.feelsLike}°C），湿度${w.humidity}%，风速${w.windSpeed}km/h（${ageStr}）`;
  }
}
