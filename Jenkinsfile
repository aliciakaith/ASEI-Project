pipeline {
  agent any
  options { timestamps(); disableConcurrentBuilds() }

  stages {
    stage('Build') {
      steps {
        echo 'Build stage running...'
      }
    }
    stage('Test') {
      steps {
        echo 'Test stage running...'
      }
    }
    stage('Deploy') {
      steps {
        echo 'Deploy placeholder stage running...'
      }
    }
  }

  post {
    success { echo "${env.JOB_NAME} #${env.BUILD_NUMBER} succeeded" }
    failure { echo "Build failed — check console output" }
  }
}
