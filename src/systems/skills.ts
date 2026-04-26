/**
 * 技能系统 - 允许通过配置文件定义可供AI调用的自定义技能
 */
import { SkillsConfig, SkillDefinition } from '../config/types';
import { logger } from '../utils/logger';

export class SkillsSystem {
  private skills: Map<string, SkillDefinition> = new Map();

  constructor(cfg: SkillsConfig) {
    for (const skill of cfg.skills) {
      if (skill.enabled !== false) {
        this.skills.set(skill.name, skill);
      }
    }
    logger.info(`[Skills] 加载 ${this.skills.size} 个技能`);
  }

  /** 调用技能，返回注入的上下文字符串（如有） */
  invoke(name: string): { found: boolean; context?: string; actions?: string[] } {
    const skill = this.skills.get(name);
    if (!skill) {
      logger.warn(`[Skills] 技能未找到: ${name}`);
      return { found: false };
    }
    logger.info(`[Skills] 调用技能: ${name}`);
    return { found: true, context: skill.prompt, actions: skill.actions };
  }

  /** 获取所有已启用的技能，用于提示词 */
  getEnabledSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /** 格式化技能列表用于提示词 */
  formatForPrompt(): string {
    const skills = this.getEnabledSkills();
    if (!skills.length) return '';
    const lines = skills.map(s => `  ${s.name}：${s.description}`);
    return `【可用技能】\n${lines.join('\n')}\n使用 <SKILL name="技能名"> 激活技能`;
  }
}
