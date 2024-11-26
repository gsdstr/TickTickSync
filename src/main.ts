import "@/static/index.css";
import "@/static/styles.css";

import {Editor, MarkdownView, Notice, Plugin, TFolder} from 'obsidian';

//settings
import {DEFAULT_SETTINGS, getSettings, ITickTickSyncSettings, updateSettings} from './settings';
//TickTick api
import {TickTickRestAPI} from './TicktickRestAPI';
import {TickTickSyncAPI} from './TicktickSyncAPI';
//task parser
import {TaskParser} from './taskParser';
//cache task read and write
import {CacheOperation} from './cacheOperation';
//file operation
import {FileOperation} from './fileOperation';

//sync module
import {SyncMan} from './syncModule';

//import modals
import {SetDefaultProjectForFileModal} from './modals/DefaultProjectModal';
import {ConfirmFullSyncModal} from "./modals/LatestChangesModal"
import {isOlder} from "./utils/version";
import {TickTickSyncSettingTab} from "./ui/settings";
import {TickTickService} from "@/services";


export default class TickTickSync extends Plugin {
	settings: ITickTickSyncSettings;
	service: TickTickService = new TickTickService(this);

	tickTickRestAPI?: TickTickRestAPI;
	tickTickSyncAPI: TickTickSyncAPI | undefined;
	taskParser: TaskParser | undefined;
	cacheOperation: CacheOperation | undefined;
	fileOperation: FileOperation | undefined;
	tickTickSync: SyncMan | undefined;
	lastLines: Map<string, number>;
	statusBar: HTMLElement;
	syncLock: boolean;

	initialized: boolean = false;

	async onload() {

		const isSettingsLoaded = await this.loadSettings();
		if (!isSettingsLoaded) {
			new Notice('Settings failed to load. Please reload the TickTickSync plugin.');
			return;
		}

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new TickTickSyncSettingTab(this.app, this));

		// const queryInjector = new QueryInjector(this);
		// this.registerMarkdownCodeBlockProcessor(
		// 	"ticktick",
		// 	queryInjector.onNewBlock.bind(queryInjector),
		// );


		this.settings.apiInitialized = false;
		try {
			await this.initializePlugin();
		} catch (error) {
			console.error('API Initialization Failed.', error);
		}

		//lastLine object {path:line} is saved in lastLines map
		this.lastLines = new Map();

		// if (this.settings.debugMode) {
		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('sync', 'TickTickSync', async (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			await this.scheduledSynchronization();
			await this.unlockSynclock();
			new Notice(`Sync completed..`);
		});
		//Used for testing adhoc code.
		// const ribbonIconEl1 = this.addRibbonIcon('check', 'TickTickSync', async (evt: MouseEvent) => {
		// 	// Nothing to see here right now.
		// });
		// }

		this.registerEvents();
		this.reloadInterval();

		// set default project for TickTick task in the current file
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'set-default-project-for-TickTick-task-in-the-current-file',
			name: 'Set default TickTick project for Tasks in the current file',
			editorCallback: (editor: Editor, view: MarkdownView) => {
				if (!view) {
					return;
				}
				const filepath = view.file.path;
				new SetDefaultProjectForFileModal(this.app, this, filepath);

			}
		});

		//display default project for the current file on status bar
		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBar = this.addStatusBarItem();
		console.log(`${this.manifest.name} ${this.manifest.version} loaded!`);
	}

	private syncInterval?: number;
	reloadInterval() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
			this.syncInterval = undefined;
		}
		const timeout = getSettings().automaticSynchronizationInterval * 1000;
		if (timeout === 0) {
			return;
		}
		this.syncInterval = window.setInterval(this.scheduledSynchronization, timeout);
	}

	private registerEvents() {
		//Key event monitoring, judging line breaks and deletions
		this.registerDomEvent(document, 'keyup', async (evt: KeyboardEvent) => {
			if (!this.settings.apiInitialized) {
				return;
			}
			//console.log(`key pressed`)
			const markDownView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const editor = markDownView?.app.workspace.activeEditor?.editor;


			if ((!markDownView) || !(editor) || (editor) && !(editor.hasFocus())) {
				// (console.log(`editor is not focused`))
				return;
			}

			if (evt.key === 'ArrowUp' || evt.key === 'ArrowDown' || evt.key === 'ArrowLeft' || evt.key === 'ArrowRight' || evt.key === 'PageUp' || evt.key === 'PageDown') {
				// console.log(`${evt.key} arrow key is released`);
				if (!(this.checkModuleClass())) {
					return;
				}
				await this.lineNumberCheck();
			}

			if (evt.key === 'Delete' || evt.key === 'Backspace') {
				try {
					//console.log(`${evt.key} key is released`);
					if (!(this.checkModuleClass())) {
						return;
					}
					if (!await this.checkAndHandleSyncLock()) return;
					await this.tickTickSync?.deletedTaskCheck(null);
					await this.unlockSynclock();
					await this.saveSettings();
				} catch (error) {
					console.error(`An error occurred while deleting tasks: ${error}`);
					await this.unlockSynclock();
				}

			}
		});

		function traverseDOMBackwards(element, callback) {
			while (element) {
				callback(element);
				element = element.previousElementSibling;

			}
		}

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', async (evt: MouseEvent) => {
			const {target} = evt;
			const markDownView = this.app.workspace.getActiveViewOfType(MarkdownView);
			const file = markDownView?.app.workspace.activeEditor?.file;
			const fileName = file?.name;
			const filepath = file?.path;

			//Here for future debugging.
			// traverseDOMBackwards(target, (element) => {
			// 	console.log(element);
			// });

			if (!this.settings.apiInitialized) {
				return;
			}
			if (!(this.checkModuleClass())) {
				return;
			}


			if (this.app.workspace.activeEditor?.editor?.hasFocus()) {
				await this.lineNumberCheck();
			} else {
				return;
			}
			//Here for future debugging.
			// const target = evt.target as HTMLInputElement;

			if (target && target.type === 'checkbox') {
				await this.checkboxEventhandle(evt);
			}
			// 	// this.tickTickSync?.fullTextModifiedTaskCheck()
			//
			// }

		});


		//hook editor-change event, if the current line contains #ticktick, it means there is a new task
		this.registerEvent(this.app.workspace.on('editor-change', async (editor, view: MarkdownView) => {
			try {
				if (!this.settings.apiInitialized) {
					return;
				}

				//TODO: lineNumberCheck also triggers a line modified check. I suspect this is redundant and
				//      inefficient when a new task is being added. I've added returns out of there, but I need for find if the last line check
				//      is needed for an add.
				await this.lineNumberCheck();
				if (!(this.checkModuleClass())) {
					return;
				}
				if (this.settings.enableFullVaultSync) {
					return;
				}
				if (!await this.checkAndHandleSyncLock()) return;
				await this.tickTickSync?.lineContentNewTaskCheck(editor, view);
				await this.saveSettings();
				await this.unlockSynclock();
			} catch (error) {
				console.error(`An error occurred while check new task in line: ${error.message}`);
				await this.unlockSynclock();
			}

		}));

		//Listen to the delete event
		this.registerEvent(this.app.vault.on('delete', async (file) => {
			if (file instanceof TFolder) {
				//individual file deletes will be handled. I hope.
				return;
			}
			if (!this.settings.apiInitialized) {
				console.error('API Not intialized!');
				return;
			}
			const fileMetadata = await this.cacheOperation?.getFileMetadata(file.path, null);
			if (!fileMetadata || !fileMetadata.TickTickTasks) {
				//console.log('There is no task in the deleted file')
				return;
			}
			if (!(this.checkModuleClass())) {
				return;
			}
			// @ts-ignore
			await this.tickTickSync.deletedTaskCheck(file.path);
			await this.cacheOperation?.deleteFilepathFromMetadata(file.path);
			await this.saveSettings();

			await this.unlockSynclock();


		}));

		//Listen to the rename event and update the path in task data
		this.registerEvent(this.app.vault.on('rename', async (file, oldpath) => {
			if (!this.settings.apiInitialized) {
				console.error('API Not intialized!');
				return;
			}
			// console.log(`${oldpath} is renamed`)
			//Read fileMetadata
			//const fileMetadata = await this.fileOperation.getFileMetadata(file)
			const fileMetadata = await this.cacheOperation?.getFileMetadata(oldpath, null);
			// console.log(fileMetadata)
			if (!fileMetadata || !fileMetadata.TickTickTasks) {
				//console.log('There is no task in the deleted file')
				return;
			}
			if (!(this.checkModuleClass())) {
				return;
			}
			await this.cacheOperation?.updateRenamedFilePath(oldpath, file.path);
			await this.saveSettings();

			//update task description
			if (!await this.checkAndHandleSyncLock()) return;
			try {
				await this.tickTickSync?.updateTaskContent(file.path);
			} catch (error) {
				console.error('An error occurred in updateTaskDescription:', error);
			}
			await this.unlockSynclock();


		}));


		//Listen for file modified events and execute fullTextNewTaskCheck
		this.registerEvent(this.app.vault.on('modify', async (file) => {
			try {
				if (!this.settings.apiInitialized) {
					return;
				}
				const filepath = file.path;
				// console.log(`${filepath} is modified`)

				//get current view

				const activateFile = this.app.workspace.getActiveFile();

				// console.log(activateFile?.path, filepath)

				//To avoid conflicts, Do not check files being edited
				if (activateFile?.path == filepath) {
					//TODO: find out if they cut or pasted task(s) in here.
					return;
				}

				if (!await this.checkAndHandleSyncLock()) return;
				// console.log("go check.")
				await this.tickTickSync?.fullTextNewTaskCheck(filepath);
				await this.unlockSynclock();

			} catch (error) {
				console.error(`An error occurred while modifying the file: ${error.message}`);
				await this.unlockSynclock();
				// You can add further error handling logic here. For example, you may want to
				// revert certain operations, or alert the user about the error.
			}
		}));

		this.registerEvent(this.app.workspace.on('active-leaf-change', async (leaf) => {
			await this.setStatusBarText();
		}));
    }


	async onunload() {
		if (this.syncInterval) {
			window.clearInterval(this.syncInterval);
		}
		console.log(`TickTickSync unloaded!`);
	}

	async loadSettings() {
		try {
			const data = await this.loadData();

			try {
				await this.migrateData(data);
			} catch (error) {
				console.error('Failed to migrate data:', error);
				return false; // Returning false indicates that the setting loading failed
			}

			updateSettings(data);
			this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
		} catch (error) {
			console.error('Failed to load data:', error);
			return false; // Returning false indicates that the setting loading failed
		}
		return true; // Returning true indicates that the settings are loaded successfully
	}

	private async migrateData(data: any) {
		if (!data) return;
		//TODO make more clean
		//We're going to handle data structure conversions here.
		if (!data.version) {
			const fileMetaDataStructure = data.fileMetadata;
			for (const file in fileMetaDataStructure) {
				const oldTasksHolder = fileMetaDataStructure[file]; //an array of tasks.
				let newTasksHolder = {};
				newTasksHolder = {
					TickTickTasks: oldTasksHolder.TickTickTasks.map((taskIDString) => ({
						taskId: taskIDString, taskItems: [] //TODO: Validate that the assumption that the next sync will fill these correctly.
					})), TickTickCount: oldTasksHolder.TickTickCount, defaultProjectId: oldTasksHolder.defaultProjectId
				};
				fileMetaDataStructure[file] = newTasksHolder;
			}
			//Force a sync
			if (this.settings && this.settings.apiInitialized) {
				await this.scheduledSynchronization();
			}
		}
		if ((!data.version) || (isOlder(data.version, '1.0.10'))) {
			//get rid of username and password. we don't need them no more.
			//delete data.username; //keep username for info
			// @ts-ignore
			delete data.password;
		}
		if ((!data.version) || (isOlder(data.version, '1.0.36'))) {
			//default to AND because that's what we used to do:
			data.tagAndOr = 1;
			//warn about tag changes.
			await this.LatestChangesModal()
		}

		//Update the version number. It will save me headaches later.
		if ((!data.version) || (isOlder(data.version, this.manifest.version))) {
			data.version = this.manifest.version;
			await this.saveSettings();
		}
    }

	async saveSettings() {
		try {
			// Verify that the setting exists and is not empty
			if (this.settings && Object.keys(this.settings).length > 0) {
				await this.saveData( //TODO: migrate to getSettings
					{
						...this.settings,
						baseURL: getSettings().baseURL,
						username: getSettings().username,
						token: getSettings().token,
						inboxID: getSettings().inboxID,
						checkPoint: getSettings().checkPoint,
						automaticSynchronizationInterval: getSettings().automaticSynchronizationInterval,
					});
			} else {
				console.error('Settings are empty or invalid, not saving to avoid data loss.');
			}
		} catch (error) {
			//Print or handle errors
			console.error('Error saving settings:', error);
		}
	}


	// return true of false
	async initializePlugin() {

		//initialize TickTick restapi
		this.tickTickRestAPI = new TickTickRestAPI(this.app, this, null);
		await this.tickTickRestAPI.initializeAPI();

		//initialize data read and write object
		this.cacheOperation = new CacheOperation(this.app, this);

		let isProjectsSaved = false;
		if (this.settings.apiInitialized) {
			isProjectsSaved = await this.cacheOperation?.saveProjectsToCache();
		}


		if (!isProjectsSaved) {
			this.tickTickRestAPI = undefined;
			this.tickTickSyncAPI = undefined;
			this.taskParser = undefined;
			this.taskParser = undefined;
			this.cacheOperation = undefined;
			this.fileOperation = undefined;
			this.tickTickSync = undefined;
			new Notice(`TickTickSync plugin initialization failed, please check userID and password in settings.`);
			return;
		}

		if (!this.initialized) {

			//Create a backup folder to back up TickTick data
			try {

				//TODO: this should not be necessary. Check why it was at some point.
				if (!this.settings.SyncTag) {
					this.settings.SyncTag = '';
					await this.saveSettings();
				}
				if (!this.settings.SyncProject) {
					this.settings.SyncProject = '';
					await this.saveSettings();
				}

				//Start the plug-in for the first time and back up TickTick data
				this.taskParser = new TaskParser(this.app, this);

				//initialize file operation
				this.fileOperation = new FileOperation(this.app, this);

				//initialize ticktick sync api
				this.tickTickSyncAPI = new TickTickSyncAPI(this.app, this);

				//initialize TickTick sync module
				this.tickTickSync = new SyncMan(this.app, this);
				// console.log('ticktick sync : ', this.tickTickSync) ;

				//Back up all data before each startup
				this.tickTickSync?.backupTickTickAllResources();

			} catch (error) {
				console.error(`error creating user data folder: ${error}`);
				new Notice(`error creating user data folder`);
				return;
			}


			//Initialize settings
			this.initialized = true;
			await this.saveSettings();
			new Notice(`TickTickSync initialization successful. TickTick data has been backed up.`);

		}

		this.initializeModuleClass();

		//get user plan resources
		//const rsp = await this.TickTickSyncAPI.getUserResource()
		// this.settings.apiInitialized = true
		await this.unlockSynclock();
		new Notice(`TickTickSync loaded successfully.`);
		return true;


	}

	initializeModuleClass() {
		// console.log("initializeModuleClass")
		//initialize TickTick restapi
		if (!this.tickTickRestAPI) {
			// console.log("API wasn't inited?")
			this.tickTickRestAPI = new TickTickRestAPI(this.app, this, null);
		}

		//initialize data read and write object
		this.cacheOperation = new CacheOperation(this.app, this);
		this.taskParser = new TaskParser(this.app, this);

		//initialize file operation
		this.fileOperation = new FileOperation(this.app, this);

		//initialize TickTick sync api
		//Todo: Do we really need it?
		this.tickTickSyncAPI = new TickTickSyncAPI(this.app, this);

		//initialize TickTick sync module
		this.tickTickSync = new SyncMan(this.app, this);
	}

	async lineNumberCheck() {
		if (!await this.checkAndHandleSyncLock()) {
			console.log("We're locked. Returning.");
			return;
		}
		let modified = false;
		const markDownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (markDownView) {
			const cursor = markDownView?.editor.getCursor();
			const line = cursor?.line;
			//const lineText = view.editor.getLine(line)
			const fileContent = markDownView.data;

			//console.log(line)
			//const fileName = view.file?.name
			const file = markDownView?.app.workspace.activeEditor?.file;
			const fileName = file?.name;
			const filepath = file?.path;

			if (typeof this.lastLines === 'undefined' || typeof this.lastLines.get(fileName as string) === 'undefined') {
				this.lastLines.set(fileName as string, line as number);
				await this.unlockSynclock();
				return false;
			}

			//console.log(`filename is ${fileName}`)
			if (this.lastLines.has(fileName as string) && line !== this.lastLines.get(fileName as string)) {
				const lastLine = this.lastLines.get(fileName as string);
				// if (this.settings.debugMode) {
				// 	console.log('Line changed!', `current line is ${line}`, `last line is ${lastLine}`);
				// }

				//Perform the operation you want
				const lastLineText = markDownView.editor.getLine(lastLine as number);
				// console.log(lastLineText)
				if (!(this.checkModuleClass())) {
					await this.unlockSynclock();
					return false;
				}
				this.lastLines.set(fileName as string, line as number);
				// try{

				modified = await this.tickTickSync?.lineModifiedTaskCheck(filepath as string, lastLineText, lastLine as number, fileContent);


				// }catch(error){
				//     console.error(`An error occurred while check modified task in line text: ${error}`);
				//     await this.unlockSynclock();
				// }
			} else {
				//console.log('Line not changed');
			}

		}
		await this.unlockSynclock();
		return modified;
	}

	async checkboxEventhandle(evt: MouseEvent) {
		const target = evt.target as HTMLInputElement;
		const bOpenTask = target.checked;

		new Notice(`Task will be updated as ${bOpenTask ? 'closed' : 'opened'} on next Sync`);
	}


	// async oldCheckboxEventhandle(evt: MouseEvent) {
	// 	if (!(this.checkModuleClass())) {
	// 		return;
	// 	}
	//
	//
	// 	const target = evt.target as HTMLInputElement;
	// 	const bOpenTask = target.checked;
	// 	console.log('Second: Checked: ', bOpenTask);
	//
	// 	//This breaks for subtasks if Tasks is installed. See: https://github.com/obsidian-tasks-group/obsidian-tasks/discussions/2685
	// 	//hence the else.
	// 	const taskElement = target.closest('div');
	// 	if (taskElement) {
	// 		const taskLine = taskElement.textContent;
	// 		const taskId = this.taskParser?.getTickTickIdFromLineText(taskLine);
	// 		if (taskId) {
	// 			// let task = this.taskParser?.convertTextToTickTickTaskObject(tas)
	// 			if (bOpenTask) {
	// 				console.log('it\'s open, close it.');
	// 				this.tickTickSync?.closeTask(taskId);
	// 			} else {
	// 				console.log('it\'s closed, open it.');
	// 				this.tickTickSync?.reopenTask(taskId);
	// 			}
	// 		}
	// 	} else {
	// 		console.log('#### TickTick_id not found -- do it the hard way.');
	// 		//Start full-text search and check status updates
	// 		try {
	// 			console.log('#### Full text modified??');
	// 			let file = this.app.workspace.getActiveFile();
	// 			let filePath = null;
	// 			if (file instanceof TFile) {
	// 				filePath = file.path;
	// 			}
	//
	// 			if (!await this.checkAndHandleSyncLock()) return;
	// 			await this.tickTickSync?.fullTextModifiedTaskCheck(filePath);
	// 			await this.unlockSynclock();
	// 		} catch (error) {
	// 			console.error(`An error occurred while check modified tasks in the file: ${error}`);
	// 			await this.unlockSynclock();
	//
	// 		}
	// 	}
	// }

	//return true
	checkModuleClass() {
		if (!getSettings().token){
			new Notice(`Please login from settings.`);
			return false;
		}

		if (!this.service.initialized) {
			this.service.initialize();
		}
		if (this.tickTickRestAPI === undefined || this.tickTickSyncAPI === undefined || this.cacheOperation === undefined || this.fileOperation === undefined || this.tickTickSync === undefined || this.taskParser === undefined) {
			this.initializeModuleClass();
		}
		return true;
	}

	async setStatusBarText() {
		if (!(this.checkModuleClass())) {
			return;
		}
		const markDownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!markDownView) {
			this.statusBar.setText('');
		} else {
			const filepath = markDownView?.file?.path;
			if (filepath === undefined) {
				// console.log(`file path undefined`)
				return;
			}
			const defaultProjectName = await this.cacheOperation?.getDefaultProjectNameForFilepath(filepath as string);
			if (defaultProjectName === undefined) {
				// console.log(`projectName undefined`)
				return;
			}
			this.statusBar.setText(defaultProjectName);
		}

	}

	async scheduledSynchronization() {
		if (!this.checkModuleClass()) {
			return;
		}

		console.log('TickTick scheduled synchronization task started at', new Date().toLocaleString());
		try {
			await this.service.synchronization();
		} catch (error) {
			console.error('An error occurred:', error);
			new Notice('An error occurred:', error);
		}
		console.log('TickTick scheduled synchronization task completed at', new Date().toLocaleString());
	}

	async checkSyncLock() {
		let checkCount = 0;
		while (this.settings.syncLock && checkCount < 10) {
			await new Promise(resolve => setTimeout(resolve, 1000));
			checkCount++;
		}
		return !this.settings.syncLock;
	}

	async unlockSynclock() {
		this.settings.syncLock = false;
		await this.saveSettings();
	}

	async checkAndHandleSyncLock() {
		if (this.settings.syncLock) {
			// console.log('sync locked.');
			const isSyncLockChecked = await this.checkSyncLock();
			if (!isSyncLockChecked) {
				return false;
			}
			// console.log('sync unlocked.')
		}
		this.settings.syncLock = true;
		await this.saveSettings();
		return true;
	}


	private async LatestChangesModal() {
		const myModal = new ConfirmFullSyncModal(this.app, (result) => {
			this.ret = result;
		});
		const bConfirmation = await myModal.showModal();

		return bConfirmation;

	}
}



