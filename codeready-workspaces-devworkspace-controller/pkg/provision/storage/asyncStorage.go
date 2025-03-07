//
// Copyright (c) 2019-2021 Red Hat, Inc.
// This program and the accompanying materials are made
// available under the terms of the Eclipse Public License 2.0
// which is available at https://www.eclipse.org/legal/epl-2.0/
//
// SPDX-License-Identifier: EPL-2.0
//
// Contributors:
//   Red Hat, Inc. - initial API and implementation
//

package storage

import (
	"errors"
	"fmt"
	"time"

	dw "github.com/devfile/api/v2/pkg/apis/workspaces/v1alpha2"
	"github.com/devfile/devworkspace-operator/apis/controller/v1alpha1"
	"github.com/devfile/devworkspace-operator/controllers/workspace/provision"
	"github.com/devfile/devworkspace-operator/internal/images"
	"github.com/devfile/devworkspace-operator/pkg/constants"
	devfileConstants "github.com/devfile/devworkspace-operator/pkg/library/constants"
	"github.com/devfile/devworkspace-operator/pkg/provision/storage/asyncstorage"

	corev1 "k8s.io/api/core/v1"
	k8sErrors "k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
)

// The AsyncStorageProvisioner provisions one PVC per namespace and creates an ssh deployment that syncs data into that PVC.
// Workspaces are provisioned with sync sidecars that sync data from the workspace to the async ssh deployment. All storage
// attached to a workspace is emptyDir volumes.
type AsyncStorageProvisioner struct{}

var _ Provisioner = (*AsyncStorageProvisioner)(nil)

func (*AsyncStorageProvisioner) NeedsStorage(workspace *dw.DevWorkspaceTemplateSpec) bool {
	return needsStorage(workspace)
}

func (p *AsyncStorageProvisioner) ProvisionStorage(podAdditions *v1alpha1.PodAdditions, workspace *dw.DevWorkspace, clusterAPI provision.ClusterAPI) error {
	if err := checkConfigured(); err != nil {
		return &ProvisioningError{
			Message: fmt.Sprintf("%s. Contact an administrator to resolve this issue.", err.Error()),
		}
	}

	numWorkspaces, _, err := p.getAsyncWorkspaceCount(clusterAPI)
	if err != nil {
		return err
	}
	// If there is more than one started workspace using async storage, then we fail starting additional ones
	// Note we need to check phase so as to not accidentally fail an already-running workspace when a second one
	// is created.
	if numWorkspaces > 1 && workspace.Status.Phase != dw.DevWorkspaceStatusRunning {
		return &ProvisioningError{
			Message: fmt.Sprintf("cannot provision storage for workspace %s", workspace.Name),
			Err:     fmt.Errorf("at most one workspace using async storage can be running in a namespace"),
		}
	}

	// Add ephemeral volumes
	if err := addEphemeralVolumesFromWorkspace(workspace, podAdditions); err != nil {
		return err
	}

	// If persistent storage is not needed, we're done
	if !p.NeedsStorage(&workspace.Spec.Template) {
		return nil
	}

	// Sync SSH keypair to cluster
	secret, configmap, err := asyncstorage.GetOrCreateSSHConfig(workspace, clusterAPI)
	if err != nil {
		if errors.Is(err, asyncstorage.NotReadyError) {
			return &NotReadyError{
				Message:      "setting up configuration for async storage",
				RequeueAfter: 1 * time.Second,
			}
		}
		return err
	}

	// Create common PVC if needed
	clusterPVC, err := syncCommonPVC(workspace.Namespace, clusterAPI)
	if err != nil {
		return err
	}

	// Create async server deployment
	deploy, err := asyncstorage.SyncWorkspaceSyncDeploymentToCluster(workspace.Namespace, configmap, clusterPVC, clusterAPI)
	if err != nil {
		if errors.Is(err, asyncstorage.NotReadyError) {
			return &NotReadyError{
				Message:      "waiting for async storage server deployment to be ready",
				RequeueAfter: 1 * time.Second,
			}
		}
		return err
	}

	// Set async deployment as owner of configmap that holds its authorized_keys
	err = controllerutil.SetOwnerReference(deploy, configmap, clusterAPI.Scheme)
	if err != nil {
		return err
	}
	err = clusterAPI.Client.Update(clusterAPI.Ctx, configmap)
	if err != nil {
		if !k8sErrors.IsConflict(err) {
			return err
		}
		return &NotReadyError{RequeueAfter: 0}
	}

	// Create service for async storage server
	_, err = asyncstorage.SyncWorkspaceSyncServiceToCluster(deploy, clusterAPI)
	if err != nil {
		if errors.Is(err, asyncstorage.NotReadyError) {
			return &NotReadyError{
				Message:      "waiting for async storage service to be ready",
				RequeueAfter: 1 * time.Second,
			}
		}
		return err
	}

	volumes, err := p.addVolumesForAsyncStorage(podAdditions, workspace)
	if err != nil {
		return err
	}

	sshSecretVolume := asyncstorage.GetVolumeFromSecret(secret)
	asyncSidecar := asyncstorage.GetAsyncSidecar(sshSecretVolume.Name, volumes)
	podAdditions.Containers = append(podAdditions.Containers, *asyncSidecar)
	podAdditions.Volumes = append(podAdditions.Volumes, *sshSecretVolume)

	return nil
}

func (p *AsyncStorageProvisioner) CleanupWorkspaceStorage(workspace *dw.DevWorkspace, clusterAPI provision.ClusterAPI) error {
	// TODO: This approach relies on there being a maximum of one workspace running per namespace.
	asyncDeploy, err := asyncstorage.GetWorkspaceSyncDeploymentCluster(workspace.Namespace, clusterAPI)
	if err != nil {
		if k8sErrors.IsNotFound(err) {
			return runCommonPVCCleanupJob(workspace, clusterAPI)
		} else {
			return err
		}
	}

	// Check if another workspace is currently using the async server
	numWorkspaces, totalWorkspaces, err := p.getAsyncWorkspaceCount(clusterAPI)
	if err != nil {
		return err
	}
	switch numWorkspaces {
	case 0:
		// no problem
	case 1:
		if workspace.Spec.Started {
			// This is the only workspace using the async server, we can safely stop it
			break
		}
		// Another async workspace is currently running; we can't safely clean up
		return &ProvisioningError{
			Message: "Cannot clean up DevWorkspace until other async-storage workspaces are stopped",
			Err:     fmt.Errorf("another workspace is using the async server"),
		}
	default:
		return &ProvisioningError{
			Message: "Cannot clean up DevWorkspace: multiple devworkspaces are using async server",
			Err:     fmt.Errorf("multiple workspaces are using using the async server"),
		}
	}

	// Scale async deployment to zero to free up common PVC
	currReplicas := asyncDeploy.Spec.Replicas
	if currReplicas == nil || *currReplicas != 0 {
		intzero := int32(0)
		asyncDeploy.Spec.Replicas = &intzero
		err := clusterAPI.Client.Update(clusterAPI.Ctx, asyncDeploy)
		if err != nil && !k8sErrors.IsConflict(err) {
			return err
		}
		return &NotReadyError{Message: "Scaling down async storage deployment to 0"}
	}

	// Clean up PVC using usual job
	err = runCommonPVCCleanupJob(workspace, clusterAPI)
	if err != nil {
		return err
	}

	// Delete the async deployment if there are no workspaces except for the one being deleted
	if totalWorkspaces <= 1 {
		err := clusterAPI.Client.Delete(clusterAPI.Ctx, asyncDeploy)
		if err != nil && !k8sErrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func (*AsyncStorageProvisioner) addVolumesForAsyncStorage(podAdditions *v1alpha1.PodAdditions, workspace *dw.DevWorkspace) (volumes []corev1.Volume, err error) {
	persistentVolumes, _, _ := getWorkspaceVolumes(workspace)

	addedVolumes, err := addEphemeralVolumesToPodAdditions(podAdditions, persistentVolumes)
	if err != nil {
		return nil, err
	}
	volumes = append(volumes, addedVolumes...)

	projectsVolume, needed := processProjectsVolume(&workspace.Spec.Template)
	if needed {
		if projectsVolume != nil && !projectsVolume.Volume.Ephemeral {
			vol, err := addEphemeralVolumesToPodAdditions(podAdditions, []dw.Component{*projectsVolume})
			if err != nil {
				return nil, err
			}
			volumes = append(volumes, vol...)
		} else {
			vol := corev1.Volume{
				Name: devfileConstants.ProjectsVolumeName,
				VolumeSource: corev1.VolumeSource{
					EmptyDir: &corev1.EmptyDirVolumeSource{},
				},
			}
			podAdditions.Volumes = append(podAdditions.Volumes, vol)
			volumes = append(volumes, vol)
		}
	}

	return volumes, nil
}

// getAsyncWorkspaceCount returns whether the async storage provider can support starting a workspace.
// Due to how cleanup for the async storage PVC is implemented, only one workspace that uses the async storage
// type can be running at a time.
func (*AsyncStorageProvisioner) getAsyncWorkspaceCount(api provision.ClusterAPI) (started, total int, err error) {
	workspaces := &dw.DevWorkspaceList{}
	err = api.Client.List(api.Ctx, workspaces)
	if err != nil {
		return 0, 0, err
	}
	for _, workspace := range workspaces.Items {
		if workspace.Labels[constants.DevWorkspaceStorageTypeLabel] == constants.AsyncStorageClassType {
			total++
			if workspace.Spec.Started {
				started++
			}
		}

	}
	return started, total, nil
}

func checkConfigured() error {
	if images.GetAsyncStorageServerImage() == "" {
		return fmt.Errorf("asynchronous storage server image is not configured")
	}
	if images.GetAsyncStorageSidecarImage() == "" {
		return fmt.Errorf("asynchronous storage sidecar image is not configured")
	}
	return nil
}
