import { App, PluginSettingTab, Setting, TextComponent, ColorComponent, ButtonComponent, Notice } from 'obsidian';
import type ObsidianPlus from './main';
import { getDeviceName, setDeviceName } from './delegateManager';

export class SettingTab extends PluginSettingTab {
  plugin: ObsidianPlus;

  constructor(app: App, plugin: ObsidianPlus) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
    containerEl.createEl('h2', { text: 'Basic Settings' });

    new Setting(containerEl)
      .setName("Tag List File")
      .setDesc("Path to a note containing tags. For example: Inbox/TaskTags.md")
      .addText(text => {
        text
          .setPlaceholder("TaskTags.md")
          .setValue(this.plugin.settings.tagListFilePath)
          .onChange(async (value) => {
            this.plugin.settings.tagListFilePath = value;
            await this.plugin.saveSettings();
            if (this.plugin.configLoader) {
              await this.plugin.configLoader.loadTaskTagsFromFile();
            } else {
              console.error("ConfigLoader not initialized");
            }
          });
      });

    // ─────────────────────── Server Settings ───────────────────────
    containerEl.createEl('h2', { text: 'Server Sync Settings' });

    new Setting(containerEl)
      .setName('Server URL')
      .setDesc('URL of obsidian-plus-server for notebook sync')
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('http://localhost:3000')
          .setValue(this.plugin.settings.serverUrl || '')
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          });
      });

    // Show registration status
    const serverManager = this.plugin.serverManager;
    const isRegistered = serverManager?.isRegistered() ?? false;

    new Setting(containerEl)
      .setName('Registration Status')
      .setDesc(isRegistered
        ? `Registered as: ${this.plugin.settings.serverCredentials?.clientId?.slice(0, 8)}...`
        : 'Not registered')
      .addButton((button: ButtonComponent) => {
        button
          .setButtonText(isRegistered ? 'Unregister' : 'Register')
          .setCta()
          .onClick(async () => {
            if (isRegistered) {
              await serverManager?.unregister();
            } else {
              const url = this.plugin.settings.serverUrl;
              if (!url) {
                new Notice('Please enter server URL first');
                return;
              }
              await serverManager?.register(url);
            }
            this.display(); // Refresh to show new status
          });
      });

    if (isRegistered) {
      new Setting(containerEl)
        .setName('Poll Now')
        .setDesc('Manually poll server for new messages')
        .addButton((button: ButtonComponent) => {
          button
            .setButtonText('Poll')
            .onClick(async () => {
              const messages = await serverManager?.poll();
              new Notice(`Received ${messages?.length ?? 0} new messages`);
            });
        });
    }

    // ─────────────────────── Delegate Settings ───────────────────────
    containerEl.createEl('h2', { text: 'Delegate Settings' });

    new Setting(containerEl)
      .setName('Device Name')
      .setDesc('Unique name for this device. Stored locally (not synced) so each device keeps its own identity.')
      .addText((text: TextComponent) => {
        text
          .setPlaceholder('e.g. macbook, iphone, home-server')
          .setValue(getDeviceName())
          .onChange(async (value) => {
            setDeviceName(value);
          });
      });

    // ─────────────────────── Tag Color Settings ───────────────────────
    containerEl.createEl('h2', { text: 'Tag Color Settings' });

    // add a toggle to use AI to summarize tasks
    new Setting(containerEl)
      .setName('Use AI to summarize tasks')
      .setDesc('AI can reword the task to be more descriptive when seen out of context')
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.useAI)
          .onChange(async (value) => {
            if (!this.plugin.settings.aiConnector && value) {
              this.plugin.settings.summarizeWithAi = false;
              this.display();
              new Notice('Please set up AI connector first');
              return;
            }
            this.plugin.settings.summarizeWithAi = value;
            await this.plugin.saveSettings();
          });
      })

    new Setting(containerEl)
      .setName('Obsidian Plus Search select behavior')
      .setDesc('Choose whether selecting a result should act like pressing Enter, Tab, or vary by device.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('insert', 'Match Enter key behavior')
          .addOption('drilldown', 'Match Tab key behavior')
          .addOption('hybrid', 'Enter on desktop, Tab on mobile')
          .setValue(this.plugin.settings.fuzzySelectionBehavior ?? 'insert')
          .onChange(async (value) => {
            this.plugin.settings.fuzzySelectionBehavior = value as 'insert' | 'drilldown' | 'hybrid';
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl('h2', { text: 'Tag Color Settings' });
    
    this.plugin.settings.tagColors.forEach((tagColor, index) => {
      const setting = new Setting(containerEl)
        .addText((text: TextComponent) => {
          text
            .setPlaceholder('Enter tag (e.g., #amazon)')
            .setValue(tagColor.tag)
            .onChange(async (value) => {
              this.plugin.settings.tagColors[index].tag = value;
              this.plugin.updateTagStyles();
              await this.plugin.saveSettings();
            });
        })
        .addColorPicker((colorPicker: ColorComponent) => {
            colorPicker
              .setValue(tagColor.textColor)
              .onChange(async (value) => {
                this.plugin.settings.tagColors[index].textColor = value;
                this.plugin.updateTagStyles();
                await this.plugin.saveSettings();
              });
          })
        .addColorPicker((colorPicker: ColorComponent) => {
          colorPicker
            .setValue(tagColor.color)
            .onChange(async (value) => {
              this.plugin.settings.tagColors[index].color = value;
              this.plugin.updateTagStyles();
              await this.plugin.saveSettings();
            });
        })
        // @ts-ignore - ButtonComponent type mismatch with ExtraButtonComponent
        .addExtraButton((button: any) => {
          button
            .setIcon('trash')
            .setTooltip('Delete')
            .onClick(async () => {
              this.plugin.settings.tagColors.splice(index, 1);
              this.display();
              this.plugin.updateTagStyles();
              await this.plugin.saveSettings();
            });
        });
    });

    new Setting(containerEl)
      .addButton((button: ButtonComponent) => {
        button
          .setButtonText('Add Tag Color')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.tagColors.push({ tag: '', color: '#ffffff', textColor: '#000000' });
            await this.plugin.saveSettings();
            this.display();
          });
      });
    
  }
}
