/*
 * Copyright (c) 2018-2020 Red Hat, Inc.
 * This program and the accompanying materials are made
 * available under the terms of the Eclipse Public License 2.0
 * which is available at https://www.eclipse.org/legal/epl-2.0/
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Contributors:
 *   Red Hat, Inc. - initial API and implementation
 */

import { AlertActionLink, AlertVariant } from '@patternfly/react-core';
import { History } from 'history';
import React from 'react';
import { connect, ConnectedProps } from 'react-redux';
import { RouteComponentProps } from 'react-router';
import { lazyInject } from '../inversify.config';
import IdeLoader, { AlertOptions } from '../pages/IdeLoader';
import { Debounce } from '../services/helpers/debounce';
import { delay } from '../services/helpers/delay';
import { IdeLoaderTab, WorkspaceStatus } from '../services/helpers/types';
import { AppState } from '../store';
import { getEnvironment, isDevEnvironment } from '../services/helpers/environment';
import * as WorkspaceStore from '../store/Workspaces';
import { selectAllWorkspaces, selectIsLoading, selectLogs, selectWorkspaceById } from '../store/Workspaces/selectors';
import { validateMachineToken } from '../services/validate-token';
import { buildWorkspacesLocation } from '../services/helpers/location';
import { DisposableCollection } from '../services/helpers/disposable';
import { Workspace } from '../services/workspaceAdapter';

type Props =
  MappedProps
  & { history: History }
  & RouteComponentProps<{ namespace: string; workspaceName: string }>;

export enum LoadIdeSteps {
  INITIALIZING = 1,
  START_WORKSPACE,
  OPEN_IDE
}

type State = {
  namespace: string;
  workspaceName: string;
  workspaceId?: string;
  currentStep: LoadIdeSteps;
  preselectedTabKey?: IdeLoaderTab;
  ideUrl?: string;
  hasError: boolean;
};

class IdeLoaderContainer extends React.PureComponent<Props, State> {

  @lazyInject(Debounce)
  private readonly debounce: Debounce;

  private readonly loadFactoryPageCallbacks: {
    showAlert?: (alertOptions: AlertOptions) => void
  };
  private isDevEnvironment: boolean;
  private readonly toDispose = new DisposableCollection();

  constructor(props: Props) {
    super(props);

    const env = getEnvironment();
    this.isDevEnvironment = isDevEnvironment(env);

    this.loadFactoryPageCallbacks = {};
    const { match: { params }, history } = this.props;
    const namespace = params.namespace;
    const workspaceName = (this.workspaceName.split('&'))[0];

    if (workspaceName !== this.workspaceName) {
      const pathname = `/ide/${namespace}/${workspaceName}`;
      history.replace({ pathname });
    }

    const workspace = this.props.allWorkspaces.find(workspace =>
      workspace.namespace === params.namespace && workspace.name === this.workspaceName);
    this.state = {
      currentStep: LoadIdeSteps.INITIALIZING,
      namespace,
      workspaceName,
      hasError: workspace?.status === WorkspaceStatus[WorkspaceStatus.ERROR],
      preselectedTabKey: this.preselectedTabKey,
    };

    const callback = async () => {
      await this.initWorkspace();
    };
    this.debounce.subscribe(callback);
    this.toDispose.push({
      dispose: () => {
        this.debounce.unsubscribe(callback);
      },
    });
  }

  private get workspaceName(): string {
    const { match: { params } } = this.props;
    return params.workspaceName.split('?')[0];
  }

  private get preselectedTabKey(): IdeLoaderTab {
    const { history: { location: { search } } } = this.props;
    if (!search) {
      return IdeLoaderTab.Progress;
    }
    const searchParam = new URLSearchParams(search);
    const tab = searchParam.get('tab');
    if (tab) {
      return IdeLoaderTab[tab];
    }
    return IdeLoaderTab.Progress;
  }

  public showAlert(alertOptions: string | AlertOptions): void {
    if (typeof alertOptions == 'string') {
      const currentAlertOptions = alertOptions;
      alertOptions = {
        title: currentAlertOptions,
        alertVariant: AlertVariant.danger
      } as AlertOptions;
    }
    if (alertOptions.alertVariant === AlertVariant.danger) {
      this.setState({ hasError: true });
    }
    if (this.loadFactoryPageCallbacks.showAlert) {
      this.loadFactoryPageCallbacks.showAlert(alertOptions);
    } else {
      console.error(alertOptions.title);
    }
  }

  public async componentWillUnmount(): Promise<void> {
    this.toDispose.dispose();
  }

  public async componentDidMount(): Promise<void> {
    const { isLoading, requestWorkspaces, allWorkspaces } = this.props;
    let workspace = allWorkspaces.find(workspace =>
      workspace.namespace === this.state.namespace && workspace.name === this.state.workspaceName);
    if (!isLoading && !workspace) {
      await requestWorkspaces();
      workspace = allWorkspaces.find(workspace =>
        workspace.namespace === this.state.namespace && workspace.name === this.state.workspaceName);
    }
    if (workspace && workspace.ideUrl && workspace.status === WorkspaceStatus[WorkspaceStatus.RUNNING]) {
      return await this.updateIdeUrl(workspace.ideUrl);
    } else if (workspace && workspace.status == WorkspaceStatus[WorkspaceStatus.ERROR]) {
      this.showErrorAlert(workspace);
    }
    this.debounce.setDelay(1000);

    const handleMessage = async (event: MessageEvent): Promise<void> => {
      if (typeof event.data !== 'string') {
        return;
      }
      if (event.data === 'show-workspaces') {
        const location = buildWorkspacesLocation();
        this.props.history.push(location);
        window.postMessage('show-navbar', '*');
      } else if (event.data.startsWith('restart-workspace:')) {
        const { allWorkspaces, match: { params } } = this.props;
        const workspace = allWorkspaces.find(workspace =>
          workspace.namespace === params.namespace && workspace.name === this.workspaceName);
        if (!workspace) {
          return;
        }
        const [, workspaceId, machineToken] = event.data.split(':');
        if (workspace.id !== workspaceId) {
          return;
        }
        try {
          await validateMachineToken(workspace.id, machineToken);
          await this.props.stopWorkspace(workspace);
          await this.props.requestWorkspace(workspace);
          this.setState({ currentStep: LoadIdeSteps.INITIALIZING });
          window.postMessage('show-navbar', '*');
        } catch (error) {
          console.error('Machine token validation failed. ', error);
        }
      }
    };
    window.addEventListener('message', handleMessage, false);
    this.toDispose.push({
      dispose: () => {
        window.removeEventListener('message', handleMessage);
      },
    });
  }

  private showErrorAlert(workspace: Workspace) {
    const wsLogs = this.props.workspacesLogs.get(workspace.id) || [];
    const alertActionLinks = this.errorActionLinks(workspace);
    this.showAlert({
      alertActionLinks: alertActionLinks,
      title: `Workspace ${this.state.workspaceName} failed to start`,
      body: this.findErrorLogs(wsLogs).join('\n'),
      alertVariant: AlertVariant.danger
    });
  }

  public async componentDidUpdate(prevProps: Props, prevState: State): Promise<void> {
    const { allWorkspaces, match: { params } } = this.props;
    const { hasError } = this.state;
    const workspace = allWorkspaces.find(workspace =>
      workspace.namespace === params.namespace
      && workspace.name === this.workspaceName);
    if (!workspace) {
      const alertOptions = {
        title: `Workspace "${this.workspaceName}" is not found.`,
        alertVariant: AlertVariant.danger,
      };
      if (this.loadFactoryPageCallbacks.showAlert) {
        this.loadFactoryPageCallbacks.showAlert(alertOptions);
      } else {
        console.error(alertOptions.title);
      }
      this.setState({
        hasError: true,
      });
    } else if (workspace.status === WorkspaceStatus[WorkspaceStatus.ERROR]) {
      if ((prevState.workspaceName === this.workspaceName) && !hasError) {
        // When the current workspace didn't have an error but now does then show it
        this.showErrorAlert(workspace);
      } else if ((prevState.workspaceName !== this.workspaceName)) {
        // When the clicked workspace changes and the new one errors then show the new error message
        this.setState({
          hasError: true,
          workspaceName: this.workspaceName,
          currentStep: LoadIdeSteps.START_WORKSPACE,
          workspaceId: workspace.id,
        });
        this.showErrorAlert(workspace);
      }
    } else if (prevState.workspaceName !== this.workspaceName) {
      // There is no error in the newly opened workspace so just reset the status back to the initial state
      this.setState({
        hasError: false,
        workspaceName: this.workspaceName,
        currentStep: LoadIdeSteps.INITIALIZING,
        workspaceId: workspace.id,
      });
    }
    this.checkOnStoppingStatus(workspace);
    this.debounce.setDelay(1000);
  }

  private checkOnStoppingStatus(workspace?: Workspace): void {
    if (!workspace) {
      return;
    }
    if (workspace.status === WorkspaceStatus[WorkspaceStatus.STOPPING]) {
      this.setState({
        currentStep: LoadIdeSteps.START_WORKSPACE
      });
    }
  }

  private findErrorLogs(wsLogs: string[]): string[] {
    const errorLogs: string[] = [];
    wsLogs.forEach(e => {
      if (e.startsWith('Error: Failed to run the workspace')) {
        // Remove the default error message and the quotations that surround the error
        const strippedError = e.replace('Error: Failed to run the workspace: ', '').slice(1, -1);
        errorLogs.push(strippedError);
      }
    });
    return errorLogs;
  }

  private errorActionLinks(workspace: Workspace): React.ReactFragment {
    return (
      <React.Fragment>
        <AlertActionLink onClick={async () => {
          this.verboseModeHandler(workspace);
        }}>Open in Verbose mode</AlertActionLink>
        <AlertActionLink onClick={() => {
          // Since patternfly appends numbers to an id we can't just get the tab by id so look for the tab item with Logs
          this.logsHandler();
        }}>Open Logs</AlertActionLink>
      </React.Fragment>
    );
  }

  private async verboseModeHandler(workspace: Workspace): Promise<void> {
    try {
      await this.props.startWorkspace(workspace, { 'debug-workspace-start': true });
      this.props.deleteWorkspaceLogs(workspace.id);
      this.setState({
        currentStep: LoadIdeSteps.INITIALIZING,
        hasError: false
      });

      // Set the workspaces status to starting manually so that when initWorkspace
      // is triggered on the debounce the workspace won't be attempted to start twice
      workspace.status = 'STARTING';

      this.logsHandler();
    } catch (e) {
      this.showAlert(`Workspace ${this.state.workspaceName} failed to start. ${e}`);
    }
  }

  private logsHandler() {
    const elements: any = Array.from(document.getElementsByClassName('pf-c-tabs__item'));
    for (const ele of elements) {
      if (ele.innerText === 'Logs') {
        ele.firstChild.click();
      }
    }
  }

  private async updateIdeUrl(ideUrl: string): Promise<void> {
    if (this.isDevEnvironment) {
      // workaround to open IDE in iframe while serving dashboard locally
      try {
        const windowRef = window.open(ideUrl);
        await delay(2000);
        windowRef?.close();
      } catch (e) {
        // noop
      }
    }
    this.setState({ currentStep: LoadIdeSteps.OPEN_IDE, ideUrl });
  }

  private async openIDE(cheWorkspace: Workspace): Promise<void> {
    this.setState({ currentStep: LoadIdeSteps.OPEN_IDE });
    try {
      await this.props.requestWorkspace(cheWorkspace);
    } catch (e) {
      this.showAlert(`Getting workspace detail data failed. ${e}`);
      return;
    }
    const workspace = this.props.allWorkspaces.find(workspace =>
      workspace.id === cheWorkspace.id);
    if (workspace && workspace.ideUrl) {
      await this.updateIdeUrl(workspace.ideUrl);
    }
  }

  private async initWorkspace(): Promise<void> {
    const { allWorkspaces, match: { params } } = this.props;
    const { namespace, workspaceName } = this.state;

    const workspace = allWorkspaces.find(workspace =>
      workspace.namespace === params.namespace && workspace.name === this.workspaceName);
    if (namespace !== params.namespace || workspaceName !== this.workspaceName) {
      this.setState({
        currentStep: LoadIdeSteps.INITIALIZING,
        hasError: workspace?.status === WorkspaceStatus[WorkspaceStatus.ERROR],
        ideUrl: '',
        namespace: params.namespace,
        workspaceName: this.workspaceName,
      });
      return;
    } else if (this.state.currentStep === LoadIdeSteps.OPEN_IDE) {
      return;
    }
    if (workspace) {
      this.props.setWorkspaceId(workspace.id);
      this.setState({ workspaceId: workspace.id });
      if ((workspace.ideUrl || this.state.currentStep === LoadIdeSteps.START_WORKSPACE) &&
        workspace.status === WorkspaceStatus[WorkspaceStatus.RUNNING]) {
        return this.openIDE(workspace);
      }
    } else {
      if (this.props.workspace) {
        this.props.clearWorkspaceId();
      }
      this.showAlert('Failed to find the target workspace.');
      return;
    }
    if (this.state.currentStep === LoadIdeSteps.INITIALIZING) {
      this.setState({ currentStep: LoadIdeSteps.START_WORKSPACE });
      await this.props.requestWorkspace(workspace);
      if (this.props.workspace?.status === WorkspaceStatus[WorkspaceStatus.STOPPED]) {
        try {
          await this.props.startWorkspace(workspace);
        } catch (e) {
          this.showAlert(`Workspace ${this.state.workspaceName} failed to start. ${e}`);
          return;
        }
      }
    }
  }

  render() {
    const { currentStep, hasError, ideUrl, workspaceId, workspaceName, preselectedTabKey } = this.state;
    const { workspace } = this.props;

    return (
      <IdeLoader
        currentStep={currentStep}
        workspaceId={workspaceId || ''}
        preselectedTabKey={preselectedTabKey}
        ideUrl={ideUrl}
        hasError={hasError}
        status={workspace ? workspace.status : undefined}
        workspaceName={workspaceName || ''}
        callbacks={this.loadFactoryPageCallbacks}
      />
    );
  }

}

const mapStateToProps = (state: AppState) => ({
  workspace: selectWorkspaceById(state),
  allWorkspaces: selectAllWorkspaces(state),
  isLoading: selectIsLoading(state),
  workspacesLogs: selectLogs(state),
});

const connector = connect(
  mapStateToProps,
  WorkspaceStore.actionCreators,
);
type MappedProps = ConnectedProps<typeof connector>;
export default connector(IdeLoaderContainer);
