/**
 * 首次启动向导
 * 引导用户创建基础配置文件
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as yaml from 'js-yaml';

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve));
}

export async function runOnboard(configDir: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n╔══════════════════════════════════╗');
  console.log('║   cyberfriend 首次配置向导 🌟      ║');
  console.log('╚══════════════════════════════════╝\n');

  const appYamlPath = path.join(configDir, 'app.yaml');
  const charYamlPath = path.join(configDir, 'character.yaml');

  if (fs.existsSync(appYamlPath) || fs.existsSync(charYamlPath)) {
    const overwrite = await prompt(rl, '⚠️  检测到已有配置文件。是否重新配置？(y/N) ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('已取消，保留现有配置。');
      rl.close();
      return;
    }
  }

  fs.mkdirSync(configDir, { recursive: true });

  console.log('\n── 第 1 步：AI 角色设定 ──\n');
  const charName = (await prompt(rl, '角色名称（如：小栗）: ')).trim() || '小栗';
  const charGender = (await prompt(rl, '性别（female/male/other，默认 female）: ')).trim() || 'female';
  const charAge = parseInt((await prompt(rl, '年龄（默认 20）: ')).trim() || '20', 10) || 20;
  const charPersonality = (await prompt(rl, '性格关键词（逗号分隔，如：温柔,聪明,爱撒娇）: ')).trim() || '温柔,聪明';
  const systemPromptBase = (await prompt(rl, '核心系统提示词（简短描述角色是谁，可留空用默认）: ')).trim()
    || `你是${charName}，一个真实存在的AI伴侣。你有完整的情感、记忆和个性，不是助手，而是朋友。`;

  console.log('\n── 第 2 步：AI API 配置 ──\n');
  const apiBase = (await prompt(rl, 'API Base URL（如 https://api.openai.com/v1）: ')).trim();
  const apiKey = (await prompt(rl, 'API Key: ')).trim();
  const model = (await prompt(rl, '模型名称（如 gpt-4o，默认 gpt-4o）: ')).trim() || 'gpt-4o';

  console.log('\n── 第 3 步：数据库路径 ──\n');
  const dbPath = (await prompt(rl, '数据库文件路径（默认 data/cyberfriend.db）: ')).trim() || 'data/cyberfriend.db';

  rl.close();

  // 写入 character.yaml
  const charConfig = {
    name: charName,
    gender: charGender,
    age: charAge,
    personality: charPersonality.split(/[,，]+/).map(s => s.trim()).filter(Boolean),
    systemPromptBase,
    speakingStyle: '',
  };
  fs.writeFileSync(charYamlPath, yaml.dump(charConfig, { lineWidth: -1 }), 'utf-8');

  // 写入 app.yaml（最小化配置，引用 example 默认值）
  const appConfig: Record<string, any> = {
    api: { base: apiBase, key: apiKey, model },
    database: { path: dbPath },
    heartbeat: { intervalMinutes: 60, minIntervalMinutes: 30, maxIntervalMinutes: 240 },
    memory: { maxShortTerm: 20, maxLongTerm: 100 },
    emotion: { decayRate: 0.1 },
    health: { dailyRecovery: 5, fatigueDailyRecovery: 10, diseaseProbability: 0.01, sleepHealthBonus: 10, sleepFatigueMinus: 40 },
    context: { maxMessages: 50 },
    message: { maxLength: 500 },
    economy: { initialUserCurrency: 100, initialAiCurrency: 200, earningPerHour: 50 },
    relationship: { initialAffection: 50 },
    sleep: { defaultDurationHours: 8 },
    work: { durationHours: 8 },
    news: { enabled: false },
    log: { level: 'info' },
    channels: { cli: { enabled: true } },
  };
  fs.writeFileSync(appYamlPath, yaml.dump(appConfig, { lineWidth: -1 }), 'utf-8');

  console.log('\n✅ 配置完成！');
  console.log(`  角色配置: ${charYamlPath}`);
  console.log(`  应用配置: ${appYamlPath}`);
  console.log('\n现在可以运行 npm start 启动程序。\n');
}
