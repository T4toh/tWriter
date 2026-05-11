import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PickFolderOptions {
  title?: string;
  defaultPath?: string;
}

export interface PickFileOptions {
  title?: string;
  defaultPath?: string;
  filters?: FileFilter[];
  multiple?: boolean;
}

@Injectable({ providedIn: 'root' })
export class NativeDialogsService {
  async pickFolder(opts: PickFolderOptions = {}): Promise<string | null> {
    const result = await invoke<string | null>('pick_folder', {
      title: opts.title ?? null,
      defaultPath: opts.defaultPath ?? null,
    });
    return result ?? null;
  }

  async pickFile(opts: PickFileOptions = {}): Promise<string[]> {
    const result = await invoke<string[]>('pick_file', {
      title: opts.title ?? null,
      defaultPath: opts.defaultPath ?? null,
      filters: opts.filters ?? null,
      multiple: opts.multiple ?? false,
    });
    return result ?? [];
  }

  async pickSingleFile(opts: Omit<PickFileOptions, 'multiple'> = {}): Promise<string | null> {
    const arr = await this.pickFile({ ...opts, multiple: false });
    return arr[0] ?? null;
  }
}
