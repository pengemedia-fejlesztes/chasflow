import { isOpen } from '../../shared/tasks';
import { useStore } from './store';

/** a menüpont jelvénye: a saját, mára esedékes vagy lejárt nyitott feladatok száma */
export function useMyTaskCount() {
  const { data } = useStore();
  return (data.tasks || []).filter((t) => isOpen(t.status) && t.assignee_id === data.me.id && t.due_date <= data.today).length;
}
