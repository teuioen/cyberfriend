import { Database, Task } from '../database/db';

export class TaskScheduler {
  constructor(private db: Database) {}

  /** 创建新任务，可附带触发时执行的行动标签 */
  create(name: string, triggerTime: Date | string, description?: string, createdBy: 'user' | 'ai' = 'ai', actionTags?: string): number {
    const ts = typeof triggerTime === 'string' ? new Date(triggerTime).getTime() : triggerTime.getTime();
    if (isNaN(ts)) throw new Error(`无效的触发时间: ${triggerTime}`);
    return this.db.saveTask({ name, description, triggerTime: ts, createdBy, createdAt: Date.now(), actionTags });
  }

  /** 获取当前应触发的任务 */
  getDueTasks(): Task[] {
    return this.db.getPendingTasks();
  }

  /** 获取未来的任务（用于提示词） */
  getFutureTasks(): Task[] {
    return this.db.getFutureTasks();
  }

  /** 标记任务完成 */
  complete(id: number): void {
    this.db.markTaskExecuted(id);
  }

  /** 格式化未来任务用于提示词 */
  formatFutureTasksForPrompt(): string {
    const tasks = this.getFutureTasks().slice(0, 5);
    if (!tasks.length) return '';
    return tasks.map(t => {
      const d = new Date(t.triggerTime);
      const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const time = `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}`;
      return `${date} ${time} ${t.name}${t.description ? ` ${t.description}` : ''}`;
    }).join('\n');
  }

  /** 格式化任务用于用户显示 */
  formatForDisplay(): string {
    const tasks = this.db.getPendingTasks();
    const future = this.getFutureTasks();
    const all = [...tasks, ...future].sort((a, b) => a.triggerTime - b.triggerTime);
    if (!all.length) return '（没有待处理的任务）';
    return all.map(t => {
      const d = new Date(t.triggerTime);
      const status = t.triggerTime <= Date.now() ? '⏰ 待执行' : '🕐 待触发';
      return `${status} [${d.toLocaleString('zh-CN')}] ${t.name} (来自:${t.createdBy})`;
    }).join('\n');
  }
}
