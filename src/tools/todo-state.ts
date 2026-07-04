export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoItem {
  id: string
  content: string
  status: TodoStatus
}

export class TodoState {
  private items: TodoItem[] = []

  replace(items: TodoItem[]): void {
    this.items = items
  }

  list(): TodoItem[] {
    return this.items
  }

  remaining(): number {
    return this.items.filter((item) => item.status !== "completed" && item.status !== "cancelled").length
  }
}
