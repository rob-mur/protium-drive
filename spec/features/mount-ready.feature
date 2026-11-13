@capability:mount-ready
Feature: The mount says when the folder is mounted

  @id:a-mount-prints-one-line-once-mounted
  Scenario: A mount prints one line that says where it is mounted once the folder is mounted
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the mount starts
    Then the mount printed one line that says it is mounted at the folder, and the folder was mounted when it did
