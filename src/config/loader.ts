import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { AppConfig, CharacterConfig, FullConfig } from './types';

let _config: FullConfig | null = null;

export function loadConfig(configDir?: string): FullConfig {
  if (_config) return _config;

  const dir = configDir ?? path.join(process.cwd(), 'config');

  const appPath = path.join(dir, 'app.yaml');
  const charPath = path.join(dir, 'character.yaml');

  if (!fs.existsSync(appPath)) {
    throw new Error(`配置文件不存在: ${appPath}`);
  }
  if (!fs.existsSync(charPath)) {
    throw new Error(`角色配置文件不存在: ${charPath}`);
  }

  const app = yaml.load(fs.readFileSync(appPath, 'utf8')) as AppConfig;
  const character = yaml.load(fs.readFileSync(charPath, 'utf8')) as CharacterConfig;

  // 环境变量覆盖（全局默认）
  if (process.env.OPENAI_BASE_URL) app.api.baseUrl = process.env.OPENAI_BASE_URL;
  if (process.env.OPENAI_API_KEY) app.api.apiKey = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_MODEL) {
    app.api.model = process.env.OPENAI_MODEL;
  }

  // 确保 main 字段存在（兼容旧配置字段 mainModel/miniModel/visionModel）
  const legacy = app.api as any;
  if (!app.api.main && legacy.mainModel) {
    app.api.main = { model: legacy.mainModel };
  }
  if (!app.api.mini && legacy.miniModel) {
    app.api.mini = { model: legacy.miniModel };
  }
  if (!app.api.vision && legacy.visionModel) {
    app.api.vision = { model: legacy.visionModel };
  }
  if (!app.api.main) {
    app.api.main = {};
  }
  if (!app.api.main.model) {
    app.api.main.model = app.api.model;
  }
  if (app.api.mini && !app.api.mini.model) {
    app.api.mini.model = app.api.model;
  }
  if (app.api.vision && !app.api.vision.model) {
    app.api.vision.model = app.api.model;
  }
  if (!app.api.main.model) {
    throw new Error('api.model / api.main.model 未配置，请在 app.yaml 中至少设置一个默认模型');
  }
  if (!app.economy) {
    throw new Error('economy 配置缺失，请在 app.yaml 中配置 dailyCurrencyUser / dailyCurrencyAi');
  }

  app.health.fatigueDailyIncrease ??= 18;
  app.work.fatiguePerHour ??= 8;
  app.sleep.fatigueSleepThreshold ??= 72;
  app.sleep.fatigueForceSleepThreshold ??= 90;

  const min = app.emotion.minValue;
  const max = app.emotion.maxValue;
  const neutral = clamp(app.emotion.neutralValue, min, max);
  const initial = app.emotion.initialValues ?? {};
  app.emotion.initialValues = {
    joy: clamp(initial.joy ?? (neutral - 8), min, max),
    sadness: clamp(initial.sadness ?? neutral, min, max),
    anxiety: clamp(initial.anxiety ?? neutral, min, max),
    anger: clamp(initial.anger ?? neutral, min, max),
    fear: clamp(initial.fear ?? neutral, min, max),
    excitement: clamp(initial.excitement ?? neutral, min, max),
    disgust: clamp(initial.disgust ?? neutral, min, max),
    shame: clamp(initial.shame ?? neutral, min, max),
    curiosity: clamp(initial.curiosity ?? (neutral - 12), min, max),
  };

  const healthInitial = app.health.initialValues ?? {};
  app.health.initialValues = {
    healthValue: clamp(healthInitial.healthValue ?? 100, 0, 100),
    fatigue: clamp(healthInitial.fatigue ?? 0, 0, 100),
  };

  const charState = character.initialState;
  if (charState) {
    if (charState.affection !== undefined) {
      app.relationship.initialAffection = clamp(charState.affection, 0, 100);
    }
    if (charState.healthValue !== undefined) {
      app.health.initialValues.healthValue = clamp(charState.healthValue, 0, 100);
    }
    if (charState.fatigue !== undefined) {
      app.health.initialValues.fatigue = clamp(charState.fatigue, 0, 100);
    }
    if (charState.emotions) {
      app.emotion.initialValues = {
        joy: clamp(charState.emotions.joy ?? app.emotion.initialValues.joy ?? neutral, min, max),
        sadness: clamp(charState.emotions.sadness ?? app.emotion.initialValues.sadness ?? neutral, min, max),
        anxiety: clamp(charState.emotions.anxiety ?? app.emotion.initialValues.anxiety ?? neutral, min, max),
        anger: clamp(charState.emotions.anger ?? app.emotion.initialValues.anger ?? neutral, min, max),
        fear: clamp(charState.emotions.fear ?? app.emotion.initialValues.fear ?? neutral, min, max),
        excitement: clamp(charState.emotions.excitement ?? app.emotion.initialValues.excitement ?? neutral, min, max),
        disgust: clamp(charState.emotions.disgust ?? app.emotion.initialValues.disgust ?? neutral, min, max),
        shame: clamp(charState.emotions.shame ?? app.emotion.initialValues.shame ?? neutral, min, max),
        curiosity: clamp(charState.emotions.curiosity ?? app.emotion.initialValues.curiosity ?? neutral, min, max),
      };
    }
  }

  // 加载 skills.yaml（可选）
  const skillsPath = path.join(dir, 'skills.yaml');
  if (fs.existsSync(skillsPath)) {
    const skillsCfg = yaml.load(fs.readFileSync(skillsPath, 'utf8')) as any;
    if (skillsCfg?.skills) {
      app.skills = skillsCfg;
    }
  }

  _config = { app, character };
  return _config;
}

export function getConfig(): FullConfig {
  if (!_config) return loadConfig();
  return _config;
}

export function resetConfig(): void {
  _config = null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
