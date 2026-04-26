/**
 * 首次配置向导（--onboard）
 * 基于 app.yaml.example 模板，交互式引导用户完成最小必要配置
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

function print(msg: string) { process.stdout.write(msg + '\n'); }
function header(title: string) { print(`\n${BOLD}${CYAN}${title}${RESET}`); }
function dim(msg: string) { return `${DIM}${msg}${RESET}`; }
function success(msg: string) { print(`${GREEN}✓ ${msg}${RESET}`); }
function warn(msg: string) { print(`${YELLOW}⚠ ${msg}${RESET}`); }

async function ask(rl: readline.Interface, question: string, defaultVal = ''): Promise<string> {
  return new Promise(resolve => {
    const prompt = defaultVal
      ? `${CYAN}?${RESET} ${question} ${dim(`(${defaultVal})`)} : `
      : `${CYAN}?${RESET} ${question} : `;
    rl.question(prompt, answer => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function confirm(rl: readline.Interface, question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  return new Promise(resolve => {
    rl.question(`${CYAN}?${RESET} ${question} ${dim(`[${hint}]`)} : `, answer => {
      const a = answer.trim().toLowerCase();
      if (!a) resolve(defaultYes);
      else resolve(a === 'y' || a === 'yes');
    });
  });
}

export async function runOnboard(configDir: string): Promise<void> {
  print(`\n${BOLD}╔══════════════════════════════════════╗${RESET}`);
  print(`${BOLD}║   CyberFriend 首次配置向导           ║${RESET}`);
  print(`${BOLD}╚══════════════════════════════════════╝${RESET}`);
  print(dim('按回车跳过可使用括号内的默认值\n'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // 检查 example 文件位置（允许 configDir 或项目根的 config/）
  const exampleCandidates = [
    path.join(configDir, 'app.yaml.example'),
    path.join(process.cwd(), 'config', 'app.yaml.example'),
  ];
  const examplePath = exampleCandidates.find(p => fs.existsSync(p));

  try {
    // ── 步骤 1：API 配置 ──────────────────────────────────────────────────
    header('步骤 1/3  API 配置');
    print(dim('支持 OpenAI 兼容接口（OpenAI / DeepSeek / 本地 llama.cpp 等）\n'));

    const baseUrl = await ask(rl, 'API 端点 BaseURL', 'https://api.openai.com/v1');
    const apiKey = await ask(rl, 'API Key（本地模型可留空）', '');
    const model = await ask(rl, '模型名称', 'gpt-4o-mini');
    const chatMaxTokens = await ask(rl, '单次最大回复 Token 数', '600');

    // ── 步骤 2：角色配置 ──────────────────────────────────────────────────
    header('步骤 2/3  角色配置');
    print(dim('用于生成 config/character.yaml（如已存在会询问是否覆盖）\n'));

    const charName = await ask(rl, 'AI 角色名字', '林汐月');
    const charGender = await ask(rl, '性别（男/女）', '女');
    const charAge = await ask(rl, '年龄', '22');
    const charProfession = await ask(rl, '职业/身份', '计算机爱好者/在校学生');

    // ── 步骤 3：信道配置 ──────────────────────────────────────────────────
    header('步骤 3/4  信道配置');
    print(dim('启用哪些信道接入（cli 为命令行，其余需额外凭证）\n'));

    const enableCli = await confirm(rl, '启用命令行（cli）信道？', true);
    const enableWechat = await confirm(rl, '启用微信（wechat）信道？', false);
    const enableFeishu = await confirm(rl, '启用飞书（feishu）信道？', false);
    const enableQQ = await confirm(rl, '启用 QQ 信道？', false);

    const enabledChannels: string[] = [];
    if (enableCli) enabledChannels.push('cli');
    if (enableWechat) enabledChannels.push('wechat');
    if (enableFeishu) enabledChannels.push('feishu');
    if (enableQQ) enabledChannels.push('qq');
    if (!enabledChannels.length) enabledChannels.push('cli');

    // ── 步骤 4：工具系统 ──────────────────────────────────────────────────
    header('步骤 4/4  工具系统（可选）');
    print(dim('工具系统允许 AI 读写文件、执行命令（沙盒目录）\n'));

    const enableTools = await confirm(rl, '启用工具系统？', false);
    let allowShell = false;
    let allowNet = false;
    if (enableTools) {
      allowShell = await confirm(rl, '允许执行命令行（shell）？', false);
      allowNet = await confirm(rl, '允许访问网络（fetch）？', false);
    }

    // ── 确认写入 ──────────────────────────────────────────────────────────
    print(`\n${BOLD}─── 配置摘要 ──────────────────────────────${RESET}`);
    print(`  API BaseURL : ${CYAN}${baseUrl}${RESET}`);
    print(`  API Key     : ${CYAN}${apiKey ? apiKey.slice(0, 8) + '...' : '（空）'}${RESET}`);
    print(`  模型         : ${CYAN}${model}${RESET}`);
    print(`  角色         : ${CYAN}${charName} (${charGender}，${charAge}岁，${charProfession})${RESET}`);
    print(`  信道         : ${CYAN}${enabledChannels.join(', ')}${RESET}`);
    print(`  工具系统     : ${CYAN}${enableTools ? `启用${allowShell ? '+shell' : ''}${allowNet ? '+网络' : ''}` : '禁用'}${RESET}`);

    const doWrite = await confirm(rl, '\n确认写入配置文件？', true);
    if (!doWrite) {
      print('\n已取消，配置文件未修改。');
      rl.close();
      return;
    }

    // ── 写入 app.yaml（基于 example 模板替换关键字段）────────────────────
    const appYamlPath = path.join(configDir, 'app.yaml');
    if (fs.existsSync(appYamlPath)) {
      fs.copyFileSync(appYamlPath, appYamlPath + '.bak');
      warn(`已将原 app.yaml 备份为 app.yaml.bak`);
    }

    fs.mkdirSync(configDir, { recursive: true });

    let appYaml: string;
    if (examplePath) {
      appYaml = fs.readFileSync(examplePath, 'utf-8');
      // 替换 API 关键字段
      appYaml = appYaml.replace(
        /baseUrl:\s*"https:\/\/your-openai-compatible-endpoint\/v1"/,
        `baseUrl: "${baseUrl}"`
      );
      appYaml = appYaml.replace(
        /apiKey:\s*"sk-[x]+"/,
        `apiKey: "${apiKey}"`
      );
      appYaml = appYaml.replace(
        /model:\s*"your-default-model-name"/,
        `model: "${model}"`
      );
      appYaml = appYaml.replace(
        /chatMaxTokens:\s*\d+/,
        `chatMaxTokens: ${chatMaxTokens || 600}`
      );
      // 替换启用信道列表（找到 enabled: 下的 - cli 那一段并替换）
      const channelListStr = enabledChannels.map(c => `    - ${c}`).join('\n');
      appYaml = appYaml.replace(
        /(  enabled:\n)((?:    - \w+\n?)+)/,
        `$1${channelListStr}\n`
      );
      // 工具系统：取消注释并配置（或追加到末尾）
      if (enableTools) {
        const toolsBlock = `tools:\n  enabled: true\n  workspace: data/workspace\n  allowShell: ${allowShell}\n  allowNet: ${allowNet}\n`;
        // 尝试取消注释现有 tools 块（以 # tools: 开头）
        if (/^# tools:/m.test(appYaml)) {
          appYaml = appYaml.replace(
            /^(# tools:\n(?:(?:#[^\n]*\n)*))/m,
            toolsBlock
          );
        } else {
          appYaml += `\n${toolsBlock}`;
        }
      }
      // 首行注释标注来源
      appYaml = `# CyberFriend 配置文件（由 --onboard 向导生成，基于 app.yaml.example）\n` + appYaml;
    } else {
      // fallback: 生成最小配置
      warn('未找到 app.yaml.example，将生成最小配置文件');
      const channelListStr = enabledChannels.map(c => `    - ${c}`).join('\n');
      appYaml = `# CyberFriend 配置文件（由 --onboard 向导生成）\napi:\n  baseUrl: "${baseUrl}"\n  apiKey: "${apiKey}"\n  model: "${model}"\n  chatMaxTokens: ${chatMaxTokens || 600}\n  temperature: 0.8\ndatabase:\n  path: "./data/cyberfriend.db"\nchannels:\n  enabled:\n${channelListStr}\nlog:\n  level: "info"\n  logDir: "./data/logs"\n`;
    }

    fs.writeFileSync(appYamlPath, appYaml, 'utf-8');
    success(`app.yaml 已写入 ${appYamlPath}`);

    // ── 写入 character.yaml ───────────────────────────────────────────────
    const charYamlPath = path.join(configDir, 'character.yaml');
    let writeChar = true;

    if (fs.existsSync(charYamlPath)) {
      writeChar = await confirm(rl, 'character.yaml 已存在，是否覆盖？', false);
      if (!writeChar) warn('character.yaml 保持不变');
    }

    if (writeChar) {
      // 基于 character.yaml.example 替换，否则生成最小模板
      const charExamplePath = examplePath
        ? path.join(path.dirname(examplePath), 'character.yaml.example')
        : path.join(process.cwd(), 'config', 'character.yaml.example');

      let charYaml: string;
      if (fs.existsSync(charExamplePath)) {
        charYaml = fs.readFileSync(charExamplePath, 'utf-8');
        const genderLabel = charGender === '女' || charGender === 'female' ? '女' : '男';
        charYaml = charYaml.replace(/^name:\s*"[^"]*"/m, `name: "${charName}"`);
        charYaml = charYaml.replace(/^gender:\s*"[^"]*"/m, `gender: "${genderLabel}"`);
        charYaml = charYaml.replace(/^age:\s*\d+/m, `age: ${charAge || 22}`);
        charYaml = charYaml.replace(/^profession:\s*"[^"]*"/m, `profession: "${charProfession}"`);
        charYaml = `# ${charName} 角色定义（由 --onboard 向导生成）\n` + charYaml;
      } else {
        const genderLabel = charGender === '女' || charGender === 'female' ? '女' : '男';
        charYaml = `# ${charName} 角色定义（由 --onboard 向导生成）\nname: "${charName}"\ngender: "${genderLabel}"\nage: ${charAge || 22}\nprofession: "${charProfession}"\npersonality:\n  - "温柔善良"\n  - "有主见"\nspeakingStyle: |\n  说话自然随意，会用语气词。末尾不带句号\nsystemPromptBase: |\n  你是 ${charName}，${charAge}岁，${charProfession}。认真扮演这个角色，不要提起自己是AI。\n`;
      }

      fs.writeFileSync(charYamlPath, charYaml, 'utf-8');
      success(`character.yaml 已写入 ${charYamlPath}`);
    }

    print(`\n${BOLD}${GREEN}配置完成！现在可以运行：${RESET}`);
    print(`  ${CYAN}npm run dev${RESET}`);

    if (enableWechat || enableFeishu || enableQQ) {
      warn('请手动补全 app.yaml 中对应信道的凭证后再启动。');
    }

  } finally {
    rl.close();
  }
}
