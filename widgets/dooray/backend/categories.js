// User-defined task categories, stored locally. Nothing is written to Dooray.
// File shape: { version, categories: [{ id, name, color }], assignments: { [taskId]: { categoryIds, task, addedAt } } }
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_CATEGORIES = 50;
const MAX_NAME = 30;
const COLOR = /^#[0-9a-f]{6}$/i;
const PALETTE = ['#7aa7ff', '#52d6a4', '#ffbd59', '#ff7272', '#c792ea', '#5ad1e6', '#f78fb3', '#a3b18a'];

class CategoryError extends Error {}

function cleanName(name) {
  const value = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!value) throw new CategoryError('분류 이름을 입력해 주세요.');
  if (value.length > MAX_NAME) throw new CategoryError(`분류 이름은 ${MAX_NAME}자 이하로 입력해 주세요.`);
  return value;
}

class CategoryStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  load() {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.data = {
        version: 1,
        categories: Array.isArray(raw.categories) ? raw.categories : [],
        assignments: raw.assignments && typeof raw.assignments === 'object' ? raw.assignments : {},
      };
    } catch {
      this.data = { version: 1, categories: [], assignments: {} };
    }
    return this.data;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const json = JSON.stringify(this.data, null, 2);
    if (json === this.lastWritten) return;
    fs.writeFileSync(this.filePath, json, 'utf8');
    this.lastWritten = json;
  }

  categories() {
    return this.load().categories;
  }

  assignments() {
    return this.load().assignments;
  }

  find(id) {
    const category = this.categories().find((c) => c.id === id);
    if (!category) throw new CategoryError('분류를 찾을 수 없습니다.');
    return category;
  }

  create({ name, color } = {}) {
    const list = this.categories();
    if (list.length >= MAX_CATEGORIES) throw new CategoryError(`분류는 최대 ${MAX_CATEGORIES}개까지 만들 수 있습니다.`);
    const clean = cleanName(name);
    if (list.some((c) => c.name === clean)) throw new CategoryError('같은 이름의 분류가 이미 있습니다.');
    const category = {
      id: `c-${crypto.randomUUID().slice(0, 8)}`,
      name: clean,
      color: COLOR.test(color || '') ? color : PALETTE[list.length % PALETTE.length],
    };
    list.push(category);
    this.persist();
    return category;
  }

  update(id, { name, color } = {}) {
    const category = this.find(id);
    if (name !== undefined) {
      const clean = cleanName(name);
      if (this.categories().some((c) => c.id !== id && c.name === clean)) throw new CategoryError('같은 이름의 분류가 이미 있습니다.');
      category.name = clean;
    }
    if (color !== undefined) {
      if (!COLOR.test(color)) throw new CategoryError('색상 형식이 올바르지 않습니다.');
      category.color = color;
    }
    this.persist();
    return category;
  }

  /** Moves a category one step up (-1) or down (+1). */
  move(id, delta) {
    const list = this.categories();
    const i = list.findIndex((c) => c.id === id);
    const j = i + Math.sign(delta);
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.persist();
  }

  remove(id) {
    this.find(id);
    const data = this.load();
    data.categories = data.categories.filter((c) => c.id !== id);
    for (const [taskId, a] of Object.entries(data.assignments)) {
      a.categoryIds = a.categoryIds.filter((c) => c !== id);
      if (!a.categoryIds.length) delete data.assignments[taskId];
    }
    this.persist();
  }

  /** Replaces the categories of a task. `task` is a contract Task object used as the offline cache. */
  setTaskCategories(task, categoryIds) {
    const known = new Set(this.categories().map((c) => c.id));
    const ids = [...new Set((categoryIds || []).map(String))].filter((id) => known.has(id));
    const data = this.load();
    if (!ids.length) {
      delete data.assignments[task.id];
    } else {
      const prev = data.assignments[task.id];
      data.assignments[task.id] = { categoryIds: ids, task: stripTask(task), addedAt: prev?.addedAt || new Date().toISOString() };
    }
    this.persist();
  }

  /** Removes closed tasks from one category (or all when categoryId is null). Returns removed count. */
  removeClosed(categoryId = null) {
    const data = this.load();
    let removed = 0;
    for (const [taskId, a] of Object.entries(data.assignments)) {
      if (a.task?.workflowClass !== 'closed') continue;
      if (categoryId && !a.categoryIds.includes(categoryId)) continue;
      a.categoryIds = categoryId ? a.categoryIds.filter((c) => c !== categoryId) : [];
      removed++;
      if (!a.categoryIds.length) delete data.assignments[taskId];
    }
    this.persist();
    return removed;
  }

  /** Refreshes cached task data after a successful fetch. */
  updateCache(tasksById) {
    let changed = false;
    for (const [taskId, a] of Object.entries(this.assignments())) {
      const fresh = tasksById.get(taskId);
      if (fresh) {
        a.task = stripTask(fresh);
        changed = true;
      }
    }
    if (changed) this.persist();
  }
}

function stripTask(task) {
  const { categoryIds, stale, ...rest } = task;
  return rest;
}

module.exports = { CategoryStore, CategoryError, PALETTE, MAX_CATEGORIES, MAX_NAME };
