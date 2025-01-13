import * as path from "node:path";
import * as fs from "node:fs/promises";

import * as diff from "diff";
import * as vscode from "vscode";

import { arePathsEqual } from "../../utils/path";
import { diagnosticsMonitor } from "../diagnostics";
import { createDirectoriesForFile } from "../../utils/fs";
import { formatResponse } from "../../core/prompts/responses";

import { DecorationController } from "./DecorationController";


export const DIFF_VIEW_URI_SCHEME = "recline-diff";

export class DiffViewProvider {
  private activeDiffEditor?: vscode.TextEditor;
  private activeLineController?: DecorationController;
  private createdDirs: string[] = [];
  private documentWasOpen = false;
  private fadedOverlayController?: DecorationController;
  private newContent?: string;
  private preDiagnostics: [vscode.Uri, vscode.Diagnostic[]][] = [];
  private relPath?: string;
  private streamedLines: string[] = [];
  editType?: "create" | "modify";
  isEditing = false;
  originalContent: string | undefined;

  constructor(private cwd: string) {}

  private async closeAllDiffViews() {
    const tabs = vscode.window.tabGroups.all
      .flatMap(tg => tg.tabs)
      .filter(
        tab =>
          tab.input instanceof vscode.TabInputTextDiff
          && tab.input?.original?.scheme === DIFF_VIEW_URI_SCHEME
      );
    for (const tab of tabs) {
      // trying to close dirty views results in save popup
      if (!tab.isDirty) {
        await vscode.window.tabGroups.close(tab);
      }
    }
  }

  private async openDiffEditor(): Promise<vscode.TextEditor> {
    if (!this.relPath) {
      throw new Error("No file path set");
    }
    const uri = vscode.Uri.file(path.resolve(this.cwd, this.relPath));
    // If this diff editor is already open (ie if a previous write file was interrupted) then we should activate that instead of opening a new diff
    const diffTab = vscode.window.tabGroups.all
      .flatMap(group => group.tabs)
      .find(
        tab =>
          tab.input instanceof vscode.TabInputTextDiff
          && tab.input?.original?.scheme === DIFF_VIEW_URI_SCHEME
          && arePathsEqual(tab.input.modified.fsPath, uri.fsPath)
      );
    if (diffTab && diffTab.input instanceof vscode.TabInputTextDiff) {
      const editor = await vscode.window.showTextDocument(diffTab.input.modified);
      return editor;
    }
    // Open new diff editor
    return new Promise<vscode.TextEditor>((resolve, reject) => {
      const fileName = path.basename(uri.fsPath);
      const fileExists = this.editType === "modify";
      const disposable = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && arePathsEqual(editor.document.uri.fsPath, uri.fsPath)) {
          disposable.dispose();
          resolve(editor);
        }
      });
      vscode.commands.executeCommand(
        "vscode.diff",
        vscode.Uri.parse(`${DIFF_VIEW_URI_SCHEME}:${fileName}`).with({
          query: Buffer.from(this.originalContent ?? "").toString("base64")
        }),
        uri,
        `${fileName}: ${fileExists ? "Original ↔ Recline's Changes" : "New File"} (Editable)`
      );
      // This may happen on very slow machines ie project idx
      setTimeout(() => {
        disposable.dispose();
        reject(new Error("Failed to open diff editor, please try again..."));
      }, 10_000);
    });
  }

  private scrollEditorToLine(line: number) {
    if (this.activeDiffEditor) {
      const scrollLine = line + 4;
      this.activeDiffEditor.revealRange(
        new vscode.Range(scrollLine, 0, scrollLine, 0),
        vscode.TextEditorRevealType.InCenter
      );
    }
  }

  async open(relPath: string): Promise<void> {
    this.relPath = relPath;
    const fileExists = this.editType === "modify";
    const absolutePath = path.resolve(this.cwd, relPath);
    this.isEditing = true;
    // if the file is already open, ensure it's not dirty before getting its contents
    if (fileExists) {
      const existingDocument = vscode.workspace.textDocuments.find(doc =>
        arePathsEqual(doc.uri.fsPath, absolutePath)
      );
      if (existingDocument && existingDocument.isDirty) {
        await existingDocument.save();
      }
    }

    // get diagnostics before editing the file, we'll compare to diagnostics after editing to see if recline needs to fix anything
    this.preDiagnostics = vscode.languages.getDiagnostics();

    if (fileExists) {
      this.originalContent = await fs.readFile(absolutePath, "utf-8");
    }
    else {
      this.originalContent = "";
    }
    // for new files, create any necessary directories and keep track of new directories to delete if the user denies the operation
    this.createdDirs = await createDirectoriesForFile(absolutePath);
    // make sure the file exists before we open it
    if (!fileExists) {
      await fs.writeFile(absolutePath, "");
    }
    // if the file was already open, close it (must happen after showing the diff view since if it's the only tab the column will close)
    this.documentWasOpen = false;
    // close the tab if it's open (it's already saved above)
    const tabs = vscode.window.tabGroups.all
      .map(tg => tg.tabs)
      .flat()
      .filter(
        tab => tab.input instanceof vscode.TabInputText && arePathsEqual(tab.input.uri.fsPath, absolutePath)
      );
    for (const tab of tabs) {
      if (!tab.isDirty) {
        await vscode.window.tabGroups.close(tab);
      }
      this.documentWasOpen = true;
    }
    this.activeDiffEditor = await this.openDiffEditor();
    this.fadedOverlayController = new DecorationController("fadedOverlay", this.activeDiffEditor);
    this.activeLineController = new DecorationController("activeLine", this.activeDiffEditor);
    // Apply faded overlay to all lines initially
    this.fadedOverlayController.addLines(0, this.activeDiffEditor.document.lineCount);
    this.scrollEditorToLine(0); // will this crash for new files?
    this.streamedLines = [];
  }

  // close editor if open?
  async reset() {
    this.editType = undefined;
    this.isEditing = false;
    this.originalContent = undefined;
    this.createdDirs = [];
    this.documentWasOpen = false;
    this.activeDiffEditor = undefined;
    this.fadedOverlayController = undefined;
    this.activeLineController = undefined;
    this.streamedLines = [];
    this.preDiagnostics = [];
  }

  async revertChanges(): Promise<void> {
    if (!this.relPath || !this.activeDiffEditor) {
      return;
    }
    const fileExists = this.editType === "modify";
    const updatedDocument = this.activeDiffEditor.document;
    const absolutePath = path.resolve(this.cwd, this.relPath);
    if (!fileExists) {
      if (updatedDocument.isDirty) {
        await updatedDocument.save();
      }
      await this.closeAllDiffViews();
      await fs.unlink(absolutePath);
      // Remove only the directories we created, in reverse order
      for (let i = this.createdDirs.length - 1; i >= 0; i--) {
        await fs.rmdir(this.createdDirs[i]);
        console.log(`Directory ${this.createdDirs[i]} has been deleted.`);
      }
      console.log(`File ${absolutePath} has been deleted.`);
    }
    else {
      // revert document
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        updatedDocument.positionAt(0),
        updatedDocument.positionAt(updatedDocument.getText().length)
      );
      edit.replace(updatedDocument.uri, fullRange, this.originalContent ?? "");
      // Apply the edit and save, since contents shouldnt have changed this wont show in local history unless of course the user made changes and saved during the edit
      await vscode.workspace.applyEdit(edit);
      await updatedDocument.save();
      console.log(`File ${absolutePath} has been reverted to its original content.`);
      if (this.documentWasOpen) {
        await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), {
          preview: false
        });
      }
      await this.closeAllDiffViews();
    }

    // edit is done
    await this.reset();
  }

  async saveChanges(): Promise<{
    newProblemsMessage: string | undefined;
    userEdits: string | undefined;
    autoFormattingEdits: string | undefined;
    finalContent: string | undefined;
  }> {
    if (!this.relPath || !this.newContent || !this.activeDiffEditor) {
      return {
        newProblemsMessage: undefined,
        userEdits: undefined,
        autoFormattingEdits: undefined,
        finalContent: undefined
      };
    }
    const absolutePath = path.resolve(this.cwd, this.relPath);
    const updatedDocument = this.activeDiffEditor.document;

    // get the contents before save operation which may do auto-formatting
    const preSaveContent = updatedDocument.getText();

    if (updatedDocument.isDirty) {
      // Save and wait for formatting to complete
      const formatPromise = new Promise<void>((resolve) => {
        const disposable = vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document === updatedDocument && e.contentChanges.length > 0 && !e.document.isDirty) {
            // When the document changes but is not dirty, it means formatting has completed
            disposable.dispose();
            resolve();
          }
        });

        // In case no formatting occurs, resolve on the next tick after save
        updatedDocument.save().then(() => {
          setTimeout(() => {
            disposable.dispose();
            resolve();
          }, 0);
        });
      });

      await formatPromise;
    }

    const postSaveContent = updatedDocument.getText();

    await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false });
    await this.closeAllDiffViews();

    /*
		Getting diagnostics before and after the file edit is a better approach than
		automatically tracking problems in real-time. This method ensures we only
		report new problems that are a direct result of this specific edit.
		Since these are new problems resulting from Recline's edit, we know they're
		directly related to the work he's doing. This eliminates the risk of Recline
		going off-task or getting distracted by unrelated issues, which was a problem
		with the previous auto-debug approach. Some users' machines may be slow to
		update diagnostics, so this approach provides a good balance between automation
		and avoiding potential issues where Recline might get stuck in loops due to
		outdated problem information. If no new problems show up by the time the user
		accepts the changes, they can always debug later using the '@problems' mention.
		This way, Recline only becomes aware of new problems resulting from his edits
		and can address them accordingly. If problems don't change immediately after
		applying a fix, Recline won't be notified, which is generally fine since the
		initial fix is usually correct and it may just take time for linters to catch up.
		*/
    const postDiagnostics = vscode.languages.getDiagnostics();
    const newProblems = diagnosticsMonitor.formatDiagnostics(
      diagnosticsMonitor.getNewDiagnostics(this.preDiagnostics, postDiagnostics),
      [
        vscode.DiagnosticSeverity.Error // only including errors since warnings can be distracting (if user wants to fix warnings they can use the @problems mention)
      ],
      this.cwd
    ); // will be empty string if no errors
    const newProblemsMessage
			= newProblems.length > 0 ? `\n\nNew problems detected after saving the file:\n${newProblems}` : "";

    // If the edited content has different EOL characters, we don't want to show a diff with all the EOL differences.
    const newContentEOL = this.newContent.includes("\r\n") ? "\r\n" : "\n";
    const normalizedPreSaveContent = preSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL; // trimEnd to fix issue where editor adds in extra new line automatically
    const normalizedPostSaveContent = postSaveContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL; // this is the final content we return to the model to use as the new baseline for future edits
    // just in case the new content has a mix of varying EOL characters
    const normalizedNewContent = this.newContent.replace(/\r\n|\n/g, newContentEOL).trimEnd() + newContentEOL;

    let userEdits: string | undefined;
    if (normalizedPreSaveContent !== normalizedNewContent) {
      // user made changes before approving edit. let the model know about user made changes (not including post-save auto-formatting changes)
      userEdits = formatResponse.createPrettyPatch(
        this.relPath.toPosix(),
        normalizedNewContent,
        normalizedPreSaveContent
      );
      // return { newProblemsMessage, userEdits, finalContent: normalizedPostSaveContent }
    }
    else {
      // no changes to recline's edits
      // return { newProblemsMessage, userEdits: undefined, finalContent: normalizedPostSaveContent }
    }

    let autoFormattingEdits: string | undefined;
    if (normalizedPreSaveContent !== normalizedPostSaveContent) {
      // auto-formatting was done by the editor
      autoFormattingEdits = formatResponse.createPrettyPatch(
        this.relPath.toPosix(),
        normalizedPreSaveContent,
        normalizedPostSaveContent
      );
    }

    return { newProblemsMessage, userEdits, autoFormattingEdits, finalContent: normalizedPostSaveContent };
  }

  scrollToFirstDiff() {
    if (!this.activeDiffEditor) {
      return;
    }
    const currentContent = this.activeDiffEditor.document.getText();
    const diffs = diff.diffLines(this.originalContent || "", currentContent);
    let lineCount = 0;
    for (const part of diffs) {
      if (part.added || part.removed) {
        // Found the first diff, scroll to it
        this.activeDiffEditor.revealRange(
          new vscode.Range(lineCount, 0, lineCount, 0),
          vscode.TextEditorRevealType.InCenter
        );
        return;
      }
      if (!part.removed) {
        lineCount += part.count || 0;
      }
    }
  }

  async update(accumulatedContent: string, isFinal: boolean) {
    if (!this.relPath || !this.activeLineController || !this.fadedOverlayController) {
      throw new Error("Required values not set");
    }
    this.newContent = accumulatedContent;

    const diffEditor = this.activeDiffEditor;
    const document = diffEditor?.document;
    if (!diffEditor || !document) {
      throw new Error("User closed text editor, unable to edit file...");
    }

    // Efficiently process content
    const newLines = accumulatedContent.split("\n");
    if (!isFinal) {
      newLines.pop(); // remove partial line
    }

    // Calculate actual differences to minimize updates
    const startLine = this.streamedLines.length;
    const endLine = newLines.length;
    const changedContent = `${newLines.slice(startLine).join("\n")}\n`;

    // Only update if there are actual changes
    if (endLine > startLine) {
      // Place cursor at beginning to avoid interference
      const beginningOfDocument = new vscode.Position(0, 0);
      diffEditor.selection = new vscode.Selection(beginningOfDocument, beginningOfDocument);

      // Batch update content
      const edit = new vscode.WorkspaceEdit();
      const rangeToReplace = new vscode.Range(startLine, 0, endLine, 0);
      edit.replace(document.uri, rangeToReplace, changedContent);
      await vscode.workspace.applyEdit(edit);

      // Efficiently update decorations - only process changed lines
      const visibleRanges = diffEditor.visibleRanges;
      const isLineVisible = (line: number) => {
        return visibleRanges.some(range => line >= range.start.line && line <= range.end.line);
      };

      // Update active line and overlay only if line is in view
      for (let line = startLine; line < endLine; line++) {
        if (isLineVisible(line)) {
          this.activeLineController.setActiveLine(line);
          this.fadedOverlayController.updateOverlayAfterLine(line, document.lineCount);
          // Smart scrolling - only scroll if line is not already visible
          if (line === endLine - 1) {
            this.scrollEditorToLine(line);
          }
        }
      }
    }

    // Update tracked content
    this.streamedLines = newLines;

    if (isFinal) {
      // Handle EOF and cleanup
      if (this.streamedLines.length < document.lineCount) {
        const edit = new vscode.WorkspaceEdit();
        edit.delete(document.uri, new vscode.Range(this.streamedLines.length, 0, document.lineCount, 0));
        await vscode.workspace.applyEdit(edit);
      }

      // Preserve EOL consistency
      if (this.originalContent?.endsWith("\n") && !accumulatedContent.endsWith("\n")) {
        this.newContent = `${accumulatedContent}\n`;
      }

      // Cleanup decorations
      this.fadedOverlayController.clear();
      this.activeLineController.clear();
    }
  }
}