// "분류" menu on Dooray notification cards (engine API 1.1 card menu): put the card's task into
// the user's own categories, or make a new one, without opening the widget.
// Changes go through the service, so the widget's category view updates right away.

/**
 * @param {{ categories: import('./backend/categories').CategoryStore,
 *           service: { findTask(id: string): object | null, updateCategories(change: Function): any } }} deps
 */
function createCategoryMenu({ categories, service }) {
  const taskIdOf = (event) => String(event.task.id);
  const assigned = (event) => new Set(categories.assignments()[taskIdOf(event)]?.categoryIds || []);
  // The live task when the dashboard has it; otherwise the event's copy (e.g. a closed task).
  const taskOf = (event) => service.findTask(taskIdOf(event)) || event.task;

  function items(event) {
    const on = assigned(event);
    return categories.categories().map((c) => ({ id: c.id, label: c.name, color: c.color, checked: on.has(c.id) }));
  }

  return {
    label: '분류',
    // Every card about one task; condition alerts and summaries have no single task.
    appliesTo: (event) => Boolean(event && event.type !== 'rule' && event.task?.id),
    items,
    toggle(event, id, checked) {
      const ids = assigned(event);
      if (checked) ids.add(id);
      else ids.delete(id);
      service.updateCategories((cats) => cats.setTaskCategories(taskOf(event), [...ids]));
      return items(event);
    },
    create: {
      placeholder: '새 분류 이름',
      run(event, name) {
        service.updateCategories((cats) => {
          const category = cats.create({ name });
          cats.setTaskCategories(taskOf(event), [...assigned(event), category.id]);
        });
        return items(event);
      },
    },
  };
}

module.exports = { createCategoryMenu };
