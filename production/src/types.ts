export type Status = 'pending'|'done'|'failed'|'blocked';
export interface Item { status: Status; error?: string|null; [key:string]: unknown }
export interface Pipeline { project_id:string; characters:Item[]; backgrounds:Item[]; scenes:Item[]; [key:string]: any }
/** Optional CLI controls for limiting and error-handling a Flow run. */
export interface RunOptions { limit?: number; only?: number[]; failFast?: boolean }
/** The resolved set of assets a run will actually process. */
export interface RunSelection { characters: Item[]; backgrounds: Item[]; scenes: Item[] }
