import { App, PluginSettingTab, Setting, TextComponent, ColorComponent, ButtonComponent, Notice } from 'obsidian';

export class SettingTab extends PluginSettingTab {
  plugin: MyPlugin;

  constructor(app: App, plugin: MyPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();
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
      .setName('Obsidian Plus Search enter key behavior')
      .setDesc('Choose what happens when you press Enter while browsing tags, tasks, or notes.')
      .addDropdown((dropdown) => {
        dropdown
          .addOption('insert', 'Insert selection')
          .addOption('drilldown', 'Drill down into selection')
          .addOption('hybrid', 'Desktop inserts, mobile drills down')
          .setValue(this.plugin.settings.fuzzySelectionBehavior ?? 'insert')
          .onChange(async (value) => {
            this.plugin.settings.fuzzySelectionBehavior = value as 'insert' | 'drilldown' | 'hybrid';
            await this.plugin.saveSettings();
          });
      });

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
        .addExtraButton((button: ButtonComponent) => {
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
    
  }
}
