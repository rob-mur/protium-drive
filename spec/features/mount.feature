@capability:mount
Feature: Mounting the Drive as a folder

  @id:the-mount-shows-drive-files-as-files
  Scenario: The mount shows the Drive's files as files
    Given a Drive whose My files holds the file "Photos/beach.jpg" containing "sand and sea"
    And the user mounts the Drive at a folder
    When the user reads the mounted file "Photos/beach.jpg"
    Then the mounted file holds "sand and sea", and the mounted folder "Photos" holds exactly "beach.jpg"

  @id:a-file-written-through-the-mount-reaches-the-drive
  Scenario: A file written through the mount reaches the Drive
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder
    When the user writes "sand and snow" to the mounted file "Photos/new.jpg"
    Then within 60 seconds the Drive holds "Photos/new.jpg" containing "sand and snow"
