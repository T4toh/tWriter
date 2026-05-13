import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class StorageHelpService {
  readonly open = signal<boolean>(false);

  openHelp(): void {
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }
}
