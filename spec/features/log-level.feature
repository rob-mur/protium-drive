@capability:log-level
Feature: One log level for the binary and the rclone it runs

  A user sets how much the binary logs with --log-level or PDM_LOG_LEVEL. The mount gives the
  same level to rclone, and marks each line rclone writes, so a journal tells the two apart.

  @id:the-help-documents-the-log-level
  Scenario: The help documents the log level option and PDM_LOG_LEVEL
    Given the proton-drive-mount binary built from the deployed revision
    When the user asks the binary for its help
    Then the help lists --log-level with the levels debug, info, warn and error, and names PDM_LOG_LEVEL under Environment

  @id:a-mount-at-the-debug-log-level-logs-rclone-at-debug-under-its-name
  Scenario: A mount at the debug log level logs at debug, and rclone does too under its own name
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder with the log level "debug"
    When the user starts the mount
    Then the mount wrote its own debug lines, and rclone's debug lines each marked "rclone: "

  @id:pdm-log-level-debug-sets-the-mount-to-debug
  Scenario: PDM_LOG_LEVEL alone sets the mount and rclone to debug
    Given a Drive whose My files holds the folder "Photos"
    And the environment the user mounts the Drive in sets PDM_LOG_LEVEL to "debug"
    And the user mounts the Drive at a folder
    When the user starts the mount
    Then the mount wrote its own debug lines, and rclone's debug lines each marked "rclone: "

  @id:the-log-level-option-wins-over-pdm-log-level
  Scenario: The log level option wins over PDM_LOG_LEVEL
    Given a Drive whose My files holds the folder "Photos"
    And the environment the user mounts the Drive in sets PDM_LOG_LEVEL to "debug"
    And the user mounts the Drive at a folder with the log level "error"
    When the user starts the mount
    Then the mount started the serve, and wrote no debug or info lines of its own and no rclone line below ERROR

  @id:a-log-level-that-is-not-a-level-stops-the-mount-before-the-serve
  Scenario: A log level option that is not a level stops the mount before the serve starts
    Given a Drive whose My files holds the folder "Photos"
    And the user mounts the Drive at a folder with the log level "loud"
    When the user starts the mount
    Then the mount exited with status 2, naming "loud", and served nothing

  @id:a-pdm-log-level-that-is-not-a-level-stops-the-mount-before-the-serve
  Scenario: A PDM_LOG_LEVEL that is not a level stops the mount before the serve starts
    Given a Drive whose My files holds the folder "Photos"
    And the environment the user mounts the Drive in sets PDM_LOG_LEVEL to "loud"
    And the user mounts the Drive at a folder
    When the user starts the mount
    Then the mount exited with status 2, naming "loud", and served nothing

  @id:the-serve-takes-the-log-level
  Scenario: The serve takes the log level option
    Given a Drive whose My files holds the folder "Photos"
    And the user serves the Drive with the log level "warn"
    When the user lists "Photos"
    Then the listing succeeds, and the serve wrote no debug or info lines
