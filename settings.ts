import { App, PluginSettingTab, Setting, TextComponent, ColorComponent, ButtonComponent } from 'obsidian';

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

    this.plugin.settings.tagColors.forEach((tagColor, index) => {
      const setting = new Setting(containerEl)
        .addText((text: TextComponent) => {
          text
            .setPlaceholder('Enter tag (e.g., #amazon)')
            .setValue(tagColor.tag)
            .onChange(async (value) => {
              this.plugin.settings.tagColors[index].tag = value;
              await this.plugin.saveSettings();
              this.plugin.updateTagStyles();
            });
        })
        .addColorPicker((colorPicker: ColorComponent) => {
            colorPicker
              .setValue(tagColor.textColor)
              .onChange(async (value) => {
                this.plugin.settings.tagColors[index].textColor = value;
                await this.plugin.saveSettings();
                this.plugin.updateTagStyles();
              });
          })
        .addColorPicker((colorPicker: ColorComponent) => {
          colorPicker
            .setValue(tagColor.color)
            .onChange(async (value) => {
              this.plugin.settings.tagColors[index].color = value;
              await this.plugin.saveSettings();
              this.plugin.updateTagStyles();
            });
        })
        .addExtraButton((button: ButtonComponent) => {
          button
            .setIcon('trash')
            .setTooltip('Delete')
            .onClick(async () => {
              this.plugin.settings.tagColors.splice(index, 1);
              await this.plugin.saveSettings();
              this.display();
              this.plugin.updateTagStyles();
            });
        });
    });

    new Setting(containerEl)
      .addButton((button: ButtonComponent) => {
        button
          .setButtonText('Add Tag Color')
          .setCta()
          .onClick(async () => {
            this.plugin.settings.tagColors.push({ tag: '', color: '#ffffff' });
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
            await this.plugin.loadTaskTagsFromFile();
          });
      });
    
  }
}
