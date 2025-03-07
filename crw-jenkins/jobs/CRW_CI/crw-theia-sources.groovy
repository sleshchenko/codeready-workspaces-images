def JOB_BRANCHES = ["2.7":"7.26.x", "2.8":"7.28.x", "2.x":"7.30.x"] // TODO switch 2.x to master, when 2.9 branches/jobs created
def JOB_DISABLED = ["2.7":true, "2.8":true, "2.x":false]
for (JB in JOB_BRANCHES) {
    SOURCE_BRANCH=JB.value
    JOB_BRANCH=""+JB.key
    MIDSTM_BRANCH="crw-" + JOB_BRANCH.replaceAll(".x","") + "-rhel-8"
    jobPath="${FOLDER_PATH}/${ITEM_NAME}_" + JOB_BRANCH
    pipelineJob(jobPath){
        disabled(JOB_DISABLED[JB.key]) // on reload of job, disable to avoid churn
        description('''
1. <a href=../crw-theia-sources_''' + JOB_BRANCH + '''>crw-theia-sources_''' + JOB_BRANCH + '''</a>: Build CRW Theia components needed for the Theia images (built in Brew), then <br/>
2. <a href=../crw-theia-containers_''' + JOB_BRANCH + '''>crw-theia-containers_''' + JOB_BRANCH + '''</a>: Trigger 3 Brew builds, then <br/>
3. <a href=../crw-theia-akamai_''' + JOB_BRANCH + '''>crw-theia-akamai_''' + JOB_BRANCH + '''</a>: Push Theia artifacts to akamai CDN <br/>

<p>
Results:
<ul>
<li><a href=https://quay.io/crw/theia-dev-rhel8>quay.io/crw/theia-dev-rhel8</a></li>
<li><a href=https://quay.io/crw/theia-rhel8>quay.io/crw/theia-rhel8</a></li>
<li><a href=https://quay.io/crw/theia-endpoint-rhel8>quay.io/crw/theia-endpoint-rhel8</a></li>
</ul>
        ''')

        properties {
            ownership {
                primaryOwnerId("nboldt")
            }

            pipelineTriggers {
                triggers{
                    pollSCM{
                        scmpoll_spec("H H/6 * * *") // every 6hrs
                    }
                }
            }

            disableResumeJobProperty()
            disableConcurrentBuildsJobProperty()
            quietPeriod(30) // no more than one build every 30s
        }

        throttleConcurrentBuilds {
            maxPerNode(1)
            maxTotal(1)
        }

        logRotator {
            daysToKeep(5)
            numToKeep(20)
            artifactDaysToKeep(5)
            artifactNumToKeep(3)
        }

        parameters{
            stringParam("SOURCE_BRANCH", SOURCE_BRANCH)
            stringParam("MIDSTM_BRANCH", MIDSTM_BRANCH)
            stringParam("PLATFORMS", "x86_64, s390x, ppc64le", "list of platforms on which to build assets; normally: x86_64, s390x, ppc64le")
        }

        // Trigger builds remotely (e.g., from scripts), using Authentication Token = CI_BUILD
        authenticationToken('CI_BUILD')

        definition {
            cps{
                sandbox(true)
                script(readFileFromWorkspace('jobs/CRW_CI/crw-theia-sources_'+JOB_BRANCH+'.jenkinsfile'))
            }
        }
    }
}